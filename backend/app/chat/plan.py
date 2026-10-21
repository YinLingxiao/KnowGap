"""Conversation-owned learning plans; all mutations are serialized by SQLite."""

import json

from app.memory.store import new_id, now

STATUSES = {"pending", "in_progress", "awaiting_learner", "done", "skipped"}


def brief(plan: dict) -> dict | None:
    if not plan["steps"]:
        return None
    return {
        "steps": [{k: step[k] for k in ("id", "title", "status", "note")} for step in plan["steps"]],
        "progress": f'{sum(s["status"] in {"done", "skipped"} for s in plan["steps"])}/{len(plan["steps"])}',
    }


class PlanStore:
    def __init__(self, store):
        self.store = store

    def _ensure(self, db):
        db.execute("""CREATE TABLE IF NOT EXISTS conversation_plans (
            conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
            version INTEGER NOT NULL DEFAULT 0,
            steps_json TEXT NOT NULL DEFAULT '[]',
            completed_at TEXT, updated_at TEXT,
            plan_user_events TEXT NOT NULL DEFAULT '[]'
        )""")

    def _load(self, db, conversation_id, student_id):
        self._ensure(db)
        owner = db.execute("SELECT * FROM conversations WHERE id=? AND student_id=?",
                           (conversation_id, student_id)).fetchone()
        if owner is None:
            raise LookupError("会话不存在或已删除。")
        row = db.execute("SELECT * FROM conversation_plans WHERE conversation_id=?", (conversation_id,)).fetchone()
        plan = {"conversation_id": conversation_id, "version": 0, "steps": [],
                "completed_at": None, "updated_at": None}
        events = []
        if row:
            plan.update(version=row["version"], steps=json.loads(row["steps_json"]),
                        completed_at=row["completed_at"], updated_at=row["updated_at"])
            events = json.loads(row["plan_user_events"])
        return plan, events, owner

    @staticmethod
    def _public(plan):
        return {**plan, "steps": [{k: v for k, v in step.items() if not k.startswith("_")}
                                  for step in plan["steps"]]}

    def _save(self, db, old, steps, events, message_id=None):
        before = {s["id"]: s for s in old["steps"]}
        changes = []
        stamp = now()
        for step in steps:
            prior = before.get(step["id"])
            if prior != step:
                step["updated_at"] = stamp
            if prior != step:
                changes.append({"step_id": step["id"], "title": step["title"],
                                "from": prior["status"] if prior else None, "to": step["status"]})
        ids = {s["id"] for s in steps}
        changes += [{"step_id": s["id"], "title": s["title"], "from": s["status"], "to": None}
                    for s in old["steps"] if s["id"] not in ids]
        changed = steps != old["steps"]
        complete = bool(steps) and all(s["status"] in {"done", "skipped"} for s in steps)
        plan = {**old, "steps": steps, "version": old["version"] + int(changed),
                "completed_at": (old["completed_at"] or stamp) if complete else None,
                "updated_at": stamp if changed else old["updated_at"]}
        db.execute("""INSERT INTO conversation_plans VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(conversation_id) DO UPDATE SET version=excluded.version,
            steps_json=excluded.steps_json, completed_at=excluded.completed_at,
            updated_at=excluded.updated_at, plan_user_events=excluded.plan_user_events""",
                   (plan["conversation_id"], plan["version"], json.dumps(steps, ensure_ascii=False),
                    plan["completed_at"], plan["updated_at"], json.dumps(events, ensure_ascii=False)))
        if changes and message_id:
            row = db.execute("SELECT meta_json FROM conversation_messages WHERE id=? AND role='assistant'",
                             (message_id,)).fetchone()
            if row:
                meta = json.loads(row["meta_json"])
                meta["plan_changes"] = [*meta.get("plan_changes", []), *changes]
                db.execute("UPDATE conversation_messages SET meta_json=? WHERE id=?",
                           (json.dumps(meta, ensure_ascii=False), message_id))
        return self._public(plan), changes

    def _sync_threads(self, db, plan, events, owner):
        # resolve_thread persists a summary and resolved state atomically. Lazy synchronization
        # keeps this module independent of the existing conversation schema/mutation paths.
        steps = json.loads(json.dumps(plan["steps"]))
        for step in steps:
            if not step.get("thread_id"):
                continue
            thread = db.execute("SELECT * FROM conversations WHERE id=? AND student_id=? AND kind='thread' "
                                "AND subject_id=? AND thread_status='resolved'",
                                (step["thread_id"], owner["student_id"], owner["subject_id"])).fetchone()
            resolution_key = (thread["resolved_at"] or thread["updated_at"]) if thread else None
            if thread and step.get("_thread_resolution") != resolution_key:
                summary = self.store._summary_message(db, thread["parent_id"], thread["id"])
                if step["status"] != "done":
                    step.update(status="done", completed_message_id=summary["id"] if summary else None)
                step["_thread_resolution"] = resolution_key
                step.pop("_awaiting_seq", None)
        if steps != plan["steps"]:
            self._save(db, plan, steps, events)
            plan, events, _ = self._load(db, plan["conversation_id"], owner["student_id"])
        return plan, events

    def read(self, conversation_id, student_id):
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            plan, events, owner = self._load(db, conversation_id, student_id)
            plan, _ = self._sync_threads(db, plan, events, owner)
            return self._public(plan)

    def context(self, conversation_id, student_id):
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            plan, events, owner = self._load(db, conversation_id, student_id)
            plan, events = self._sync_threads(db, plan, events, owner)
            if events:
                db.execute("UPDATE conversation_plans SET plan_user_events='[]' WHERE conversation_id=?",
                           (conversation_id,))
            return brief(self._public(plan)), events

    @staticmethod
    def _title(value):
        if not isinstance(value, str) or not 1 <= len(value.strip()) <= 60:
            raise ValueError("title 必须为 1~60 字。")
        return value.strip()

    def update(self, conversation_id, student_id, items, message_id=None, user_message_id=None):
        if not isinstance(items, list) or not 1 <= len(items) <= 8:
            raise ValueError("steps 必须包含 1~8 步。")
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            old, events, owner = self._load(db, conversation_id, student_id)
            old, events = self._sync_threads(db, old, events, owner)
            seq = self._user_seq(db, conversation_id, user_message_id)
            waiting_seq = self._user_seq(db, conversation_id, None)
            steps, rejected, matched = [], [], set()
            active = False
            for item in items:
                if not isinstance(item, dict):
                    raise ValueError("步骤必须是对象。")
                title = self._title(item.get("title"))
                if any(item.get(key) is not None and not isinstance(item[key], str) for key in ("id", "thread_id")):
                    raise ValueError("id 和 thread_id 必须是字符串。")
                status = item.get("status")
                if not isinstance(status, str) or status not in STATUSES:
                    raise ValueError("步骤状态无效。")
                note = item.get("note", "")
                if not isinstance(note, str) or len(note) > 120:
                    raise ValueError("note 必须不超过 120 字。")
                prior = next((s for s in old["steps"] if
                              (s["id"] == item["id"] if item.get("id") else s["title"] == title)
                              and s["id"] not in matched), None)
                if prior:
                    matched.add(prior["id"])
                if item.get("id") and any(s["id"] == item["id"] for s in steps):
                    raise ValueError("步骤 id 不能重复。")
                if prior and prior["status"] == "done" and status != "done":
                    status = "done"
                    rejected.append(f"{title}：AI 不能回退 done。")
                if prior and prior["status"] == "awaiting_learner" and status == "done" and seq <= prior.get("_awaiting_seq", seq):
                    status = "awaiting_learner"
                    rejected.append(f"{title}：进入等待后尚无学习者新消息。")
                if status == "in_progress":
                    if active:
                        status = "pending"
                        rejected.append(f"{title}：同时最多一个 in_progress，已改为 pending。")
                    active = True
                step = {**(prior or {}), "id": prior["id"] if prior else new_id("step"),
                        "title": title, "status": status, "note": note,
                        "thread_id": item.get("thread_id"), "completed_message_id": None,
                        "updated_at": prior["updated_at"] if prior else now()}
                if step["thread_id"]:
                    valid = db.execute("SELECT id FROM conversations WHERE id=? AND student_id=? AND kind='thread' "
                                       "AND subject_id=?", (step["thread_id"], student_id, owner["subject_id"])).fetchone()
                    if not valid:
                        step["thread_id"] = None
                        rejected.append(f"{title}：thread_id 不属于当前学生的同一学习空间，已丢弃。")
                if prior and step["thread_id"] != prior.get("thread_id"):
                    step.pop("_thread_resolution", None)
                if status == "done":
                    step["completed_message_id"] = prior.get("completed_message_id") if prior and prior["status"] == "done" else message_id
                if status == "awaiting_learner":
                    step["_awaiting_seq"] = prior.get("_awaiting_seq", waiting_seq) if prior and prior["status"] == status else waiting_seq
                else:
                    step.pop("_awaiting_seq", None)
                steps.append(step)
            plan, changes = self._save(db, old, steps, events, message_id)
            return {"plan": plan, "rejected_changes": rejected, "plan_changes": changes}

    @staticmethod
    def _user_seq(db, conversation_id, message_id):
        if message_id:
            row = db.execute("SELECT seq FROM conversation_messages WHERE id=? AND conversation_id=? AND role='user'",
                             (message_id, conversation_id)).fetchone()
            return row["seq"] if row else 0
        return db.execute("SELECT COALESCE(MAX(seq), 0) FROM conversation_messages WHERE conversation_id=? AND role='user'",
                          (conversation_id,)).fetchone()[0]

    def user_action(self, conversation_id, student_id, action, step_id=None, title=None, status=None):
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            old, events, owner = self._load(db, conversation_id, student_id)
            old, events = self._sync_threads(db, old, events, owner)
            steps = json.loads(json.dumps(old["steps"]))
            step = next((s for s in steps if s["id"] == step_id), None)
            if action in {"patch", "delete"} and step is None:
                raise LookupError("步骤不存在。")
            if action == "add":
                title = self._title(title)
                steps.append({"id": new_id("step"), "title": title, "status": "pending", "note": "",
                              "thread_id": None, "completed_message_id": None, "updated_at": now()})
                event = f"用户新增了步骤「{title}」"
            elif action == "patch":
                labels = {"done": "完成", "skipped": "跳过", "pending": "重置"}
                if status is not None:
                    if status not in labels:
                        raise ValueError("用户只能设置 done、skipped 或 pending。")
                    step.update(status=status, completed_message_id=None)
                    step.pop("_awaiting_seq", None)
                event = f'用户{labels[status] if status else "修改"}了「{step["title"]}」'
                if title is not None:
                    step["title"] = self._title(title)
                    event += f'，标题为「{step["title"]}」'
            elif action == "delete":
                steps.remove(step)
                event = f'用户删除了步骤「{step["title"]}」'
            elif action == "clear":
                steps = []
                event = "用户清空了学习计划"
            else:
                raise ValueError("未知计划操作。")
            plan, _ = self._save(db, old, steps, [*events, event])
            return plan

    def apply_analysis(self, conversation_id, student_id, updates, message_id, user_message_id):
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            old, events, owner = self._load(db, conversation_id, student_id)
            old, events = self._sync_threads(db, old, events, owner)
            seq = self._user_seq(db, conversation_id, user_message_id)
            steps = json.loads(json.dumps(old["steps"]))
            ids = {u["id"] for u in updates if u.get("status") == "done"}
            for step in steps:
                if step["id"] in ids and step["status"] == "awaiting_learner" and seq > step.get("_awaiting_seq", seq):
                    step.update(status="done", completed_message_id=message_id)
                    step.pop("_awaiting_seq", None)
            return self._save(db, old, steps, events, message_id)
