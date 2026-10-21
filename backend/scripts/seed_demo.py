"""导入或清除路演用的合成演示数据。只写入带 seed-demo- 标记的会话和「（演示档案）」条目。"""

from __future__ import annotations

import argparse
import json
import random
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.chat.store import ChatStore
from app.config import Settings
from app.memory.curated import join_entries, split_entries
from app.memory.store import Store
from app.models.schemas import DEMO_STUDENT
from app.services.materials import MaterialStore

REQUEST_PREFIX = "seed-demo-"
PROFILE_MARK = "（演示档案）"
DS_NAME = "数据结构（演示）"
CIRCUIT_NAME = "电路原理（演示）"
DS_DESCRIPTION = "演示数据：合成的数据结构学习记录，不含真实个人信息。"
CIRCUIT_DESCRIPTION = "演示数据：用来对照多个学习空间，不含真实个人信息。"
DS_MAIN = "seed-demo-ds-main"
CIRCUIT_MAIN = "seed-demo-circuit-main"

PROFILE_ENTRIES = (
    "[Identity] 演示身份：本机演示学生，计算机专业，已学过 C 语言（演示档案）",
    "[Preference] 演示偏好：新概念先给一个具体例子，再写定义（演示档案）",
    "[Context] 演示目标：十天后有数据结构随堂测验，希望先补栈和队列（演示档案）",
    "[Activity] 演示近况：这周在纠栈的后进先出和循环队列判满（演示档案）",
    "[Experience] 演示经验：易混概念用对照表记，比只背定义记得住（演示档案）",
)


AGENDA_PREFIX = "task-seed-demo-"
FOCUS_PREFIX = "focus-seed-demo-"


def _subject_id(db, student_id: str, name: str) -> str | None:
    row = db.execute("SELECT id, deadline FROM subjects WHERE student_id = ? AND name = ?", (student_id, name)).fetchone()
    return row["id"] if row else None


def seed_agenda(store: ChatStore, student_id: str) -> None:
    """演示日程：固定 id，重复运行不会重复插入；闪回任务由日程后端根据误区记忆自动生成。"""
    from app.agenda.store import ensure

    ensure(store)
    today = date.today()
    day = lambda offset: (today + timedelta(days=offset)).isoformat()  # noqa: E731
    stamp = datetime.now(timezone.utc).isoformat()
    with store.connection() as db:
        ds = _subject_id(db, student_id, DS_NAME)
        circuit = _subject_id(db, student_id, CIRCUIT_NAME)
        rows = [
            # id 后缀, 标题, 父任务, 优先级, 标签, 空间, 计划日期, 开始时间, 时长, 截止日, 状态, 来源
            ("queue", "复习循环队列判满条件（演示）", None, 1, ["数据结构"], ds, day(0), f"{day(0)}T15:00", 45, None, "open", "manual"),
            ("tree", "整理二叉树三种遍历的笔记（演示）", None, 2, ["数据结构", "笔记"], ds, day(1), None, None, None, "open", "manual"),
            ("stack", "完成栈的出栈序列练习（演示）", None, 3, ["数据结构"], ds, day(0), f"{day(0)}T09:30", 30, None, "done", "manual"),
            ("final", "期末冲刺：数据结构（演示）", None, 1, ["期末"], ds, None, None, None, day(10), "open", "ai_breakdown"),
            ("final-1", "哈希冲突两种处理方法对比", "final", 2, ["期末"], ds, day(2), f"{day(2)}T19:00", 60, None, "open", "ai_breakdown"),
            ("final-2", "图的 BFS / DFS 手推三道题", "final", 2, ["期末"], ds, day(4), f"{day(4)}T14:00", 90, None, "open", "ai_breakdown"),
            ("final-3", "整卷模拟一套并订正", "final", 1, ["期末"], ds, day(8), f"{day(8)}T09:00", 120, None, "open", "ai_breakdown"),
            ("thevenin", "戴维南定理例题 3 道（演示）", None, 3, ["电路原理"], circuit, day(2), f"{day(2)}T10:00", 45, day(5), "open", "manual"),
        ]
        for suffix, title, parent, priority, labels, subject, scheduled, start, minutes, deadline, status, source in rows:
            db.execute(
                "INSERT OR IGNORE INTO agenda_tasks(id, student_id, title, notes, parent_id, priority, labels, subject_id, "
                "scheduled_date, scheduled_start_at, duration_minutes, deadline_date, status, completed_at, source, "
                "sort_order, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
                (AGENDA_PREFIX + suffix, student_id, title, AGENDA_PREFIX + parent if parent else None, priority,
                 json.dumps(labels, ensure_ascii=False), subject, scheduled, start, minutes, deadline, status,
                 stamp if status == "done" else None, source, stamp, stamp),
            )


def seed_focus(store: ChatStore, student_id: str) -> None:
    """演示专注记录：最近 12 周、固定随机种子，热力图每次看起来一样。"""
    from app.focus.store import FocusStore

    FocusStore(store).ensure()
    rng = random.Random(20261024)
    today = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    with store.connection() as db:
        ds = _subject_id(db, student_id, DS_NAME)
        index = 0
        for back in range(83, -1, -1):
            # 越接近考试越勤快：后几周专注天数更多
            if rng.random() > 0.35 + 0.5 * (83 - back) / 83:
                continue
            for _ in range(rng.choice((1, 1, 2, 3))):
                index += 1
                minutes = rng.choice((25, 25, 45, 15))
                started = today - timedelta(days=back) + timedelta(hours=rng.choice((9, 14, 16, 20)), minutes=rng.randrange(0, 50))
                ended = started + timedelta(minutes=minutes)
                db.execute(
                    "INSERT OR IGNORE INTO focus_sessions(id, student_id, task_id, subject_id, title, planned_minutes, "
                    "started_at, ended_at, actual_seconds, status, note) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'completed', ?)",
                    (f"{FOCUS_PREFIX}{index:03d}", student_id, ds, "数据结构专注（演示）", minutes,
                     started.isoformat(), ended.isoformat(), minutes * 60, "演示专注记录"),
                )


def _reset_agenda_and_focus(db, student_id: str, subject_ids: list[str]) -> None:
    tables = {row["name"] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if "agenda_tasks" in tables:
        db.execute("DELETE FROM agenda_tasks WHERE student_id = ? AND id LIKE ?", (student_id, f"{AGENDA_PREFIX}%"))
        if subject_ids:
            # 演示空间里后来手动或由 AI 添加的任务也属于演示数据，空间删掉后不能留下孤儿任务
            placeholders = ",".join("?" * len(subject_ids))
            db.execute(
                f"DELETE FROM agenda_tasks WHERE student_id = ? AND subject_id IN ({placeholders})",
                (student_id, *subject_ids),
            )
            # 由演示误区自动生成的闪回任务也一并清掉
            placeholders = ",".join("?" * len(subject_ids))
            db.execute(
                f"DELETE FROM agenda_tasks WHERE student_id = ? AND source = 'review' AND memory_id IN "
                f"(SELECT id FROM learner_memories WHERE student_id = ? AND subject_id IN ({placeholders}))",
                (student_id, student_id, *subject_ids),
            )
    if "focus_sessions" in tables:
        db.execute("DELETE FROM focus_sessions WHERE student_id = ? AND id LIKE ?", (student_id, f"{FOCUS_PREFIX}%"))


def resolve_db(explicit: str | None) -> Path:
    """默认是 Settings 解析出的库。传入目录时视为桌面版 KNOWGAP_DATA_DIR。"""
    if not explicit:
        return Settings().resolved_database_path()
    path = Path(explicit).expanduser()
    if path.is_dir():
        return (path / "knowgap.sqlite3").resolve()
    return path.resolve()


def open_store(path: Path) -> ChatStore:
    base = Store(path)
    base.initialize()
    MaterialStore(base).initialize()
    store = ChatStore(base)
    store.initialize()
    return store


def _subject_by_request(store: ChatStore, student_id: str, request_id: str):
    with store.connection() as db:
        row = db.execute(
            "SELECT subject_id FROM conversations WHERE student_id = ? AND client_request_id = ?",
            (student_id, request_id),
        ).fetchone()
    if row is None or not row["subject_id"]:
        return None
    return store.subject(row["subject_id"], student_id)


def _stamp_main(store: ChatStore, student_id: str, conversation_id: str, request_id: str) -> None:
    with store.connection() as db:
        current = db.execute(
            "SELECT client_request_id FROM conversations WHERE id = ? AND student_id = ?",
            (conversation_id, student_id),
        ).fetchone()
        if current is None:
            raise RuntimeError(f"主对话不存在：{conversation_id}")
        if current["client_request_id"] == request_id:
            return
        if current["client_request_id"]:
            raise RuntimeError(f"主对话已有其他标记：{conversation_id}")
        db.execute(
            "UPDATE conversations SET client_request_id = ? WHERE id = ? AND student_id = ?",
            (request_id, conversation_id, student_id),
        )


def _ensure_subject(
    store: ChatStore, student_id: str, *, name: str, description: str, instructions: str,
    goal: str, level: str, deadline: str | None, color: str, request_id: str,
):
    found = _subject_by_request(store, student_id, request_id)
    if found is None:
        for subject in store.subjects(student_id):
            if subject.name != name or subject.description != description:
                continue
            with store.connection() as db:
                row = db.execute(
                    "SELECT client_request_id FROM conversations WHERE id = ?",
                    (subject.main_conversation_id,),
                ).fetchone()
            if row and row["client_request_id"] not in (None, request_id):
                continue
            _stamp_main(store, student_id, subject.main_conversation_id, request_id)
            found = store.subject(subject.id, student_id)
            break
    if found is not None:
        return store.update_subject(found.id, student_id, {
            "description": description, "instructions": instructions, "goal": goal,
            "level": level, "deadline": deadline, "color": color,
        })
    created = store.create_subject(
        student_id, name, description, instructions,
        goal=goal, level=level, deadline=deadline, color=color,
    )
    _stamp_main(store, student_id, created.main_conversation_id, request_id)
    return created


def _user(store: ChatStore, conversation_id: str, content: str, request_id: str) -> str:
    found = store.find_request(conversation_id, request_id)
    if found:
        return found
    return store.add_user_message(conversation_id, content, request_id)


def _reply(store: ChatStore, conversation_id: str, user_message_id: str, content: str) -> None:
    if store.replies(user_message_id):
        return
    reply_id = store.start_reply(conversation_id, user_message_id, [])
    store.finish_reply(reply_id, content=content, status="complete")


def _turns(store: ChatStore, conversation_id: str, turns: tuple[tuple[str, str, str], ...]) -> dict[str, str]:
    ids: dict[str, str] = {}
    for key, user, assistant in turns:
        message_id = _user(store, conversation_id, user, f"{REQUEST_PREFIX}{key}")
        ids[key] = message_id
        _reply(store, conversation_id, message_id, assistant)
    return ids


def _observe(store: ChatStore, student_id: str, subject_id: str, messages: dict[str, str], spec: dict) -> None:
    message_id = messages[spec["key"]]
    message = store.message(message_id, student_id)
    if message is None or message.role != "user" or spec["quote"] not in message.content:
        raise RuntimeError(f"证据不在用户消息里：{spec['topic']}")
    store.record_observation(
        student_id, kind=spec["kind"], topic=spec["topic"], topic_key=spec["topic_key"],
        summary=spec["summary"], quote=spec["quote"], reason=spec["reason"], signal=spec["signal"],
        related_id=None, conversation_id=message.conversation_id, message_id=message_id,
        subject_id=subject_id, tags=spec["tags"],
    )


def _resolve(store: ChatStore, student_id: str, thread_id: str, title: str, summary: str, takeaways: list[str]) -> None:
    conversation = store.conversation(thread_id, student_id)
    if conversation is None:
        raise RuntimeError(f"Thread 不存在：{title}")
    if conversation.thread_status == "resolved":
        return
    store.resolve_thread(thread_id, student_id, title, summary, takeaways)


def _seed_profile(store: ChatStore, student_id: str) -> None:
    for entry in PROFILE_ENTRIES:
        if PROFILE_MARK not in entry or "演示" not in entry:
            raise RuntimeError("档案条目缺少演示标记")
        result = store.apply_agent_memory(student_id, "add", "user", entry, "", False)
        if result.startswith("已存在") or result.startswith("已更新"):
            continue
        raise RuntimeError(result)


def _clear_profile(store: ChatStore, student_id: str) -> None:
    items = split_entries(store.agent_notes(student_id).get("user") or "")
    kept = [item for item in items if PROFILE_MARK not in item]
    if kept == items:
        return
    store.save_agent_note(student_id, "user", join_entries(kept))


def _seed_data_structures(store: ChatStore, student_id: str, deadline: str) -> None:
    subject = _ensure_subject(
        store, student_id, name=DS_NAME, description=DS_DESCRIPTION,
        instructions="演示时先引用学生原话，再纠正栈、队列、树和哈希的易错点。",
        goal="十天内过完栈、队列、二叉树和哈希的易错点（演示）",
        level="exam", deadline=deadline, color="#3d6fdb", request_id=DS_MAIN,
    )
    messages = _turns(store, subject.main_conversation_id, (
        ("ds-u1", "我在准备数据结构测验（演示）。我一直觉得栈是先进先出的。",
         "演示讲解：栈是后进先出。最后压进去的盘子最先拿走，不是排队。"),
        ("ds-u2", "循环队列我更糊涂（演示）：循环队列队满和队空都是 front 等于 rear，所以根本没法区分。",
         "演示讲解：只看 front 等于 rear 分不清队空和队满。常见做法是空出一个单元，或另外记录元素个数。"),
        ("ds-u3", "二叉树这边（演示），中序遍历是先访问根，再左子树，再右子树。不过完全二叉树按层编号，左孩子是 2i，右孩子是 2i+1，这个我记得住。",
         "演示讲解：中序是左、根、右。先根的是前序。编号公式可以保留。"),
        ("ds-u4", "哈希表里不同键算出同一个值说明哈希函数坏了（演示）。",
         "演示讲解：冲突是允许的。不同键落到同一槽，要用链地址或开放定址处理，不是把函数判废。"),
        ("ds-u5", "还有一个困惑（演示）：递归调用不会占用栈空间，只有自己 new 一个栈才算用栈。",
         "演示讲解：每次调用都会把返回地址压进系统栈，返回时再弹出。"),
        ("ds-u6", "顺序栈入栈是 top 加一后写入，出栈是先读再 top 减一。这个我能写对（演示）。",
         "演示讲解：对。入栈先移动栈顶指针再写入，出栈先取出再回退。"),
        ("ds-u7", "队列是先进先出，队头删除，队尾插入（演示）。",
         "演示讲解：对。队头出队，队尾入队，和栈的同一端进出不同。"),
        ("ds-u8", "我改一下前面的递归（演示）：递归返回时也会一层层从系统栈弹出。",
         "演示讲解：这次对了。调用压栈，返回弹栈。"),
    ))
    stack_title = "栈是后进先出（演示）"
    queue_title = "循环队列判满（演示）"
    hash_title = "哈希冲突处理（演示）"
    stack_id = store.create_thread(
        student_id, subject.id, title=stack_title, anchor_message_id=messages["ds-u1"],
        client_request_id="seed-demo-ds-thread-stack",
    )
    messages.update(_turns(store, stack_id, (
        ("ds-t-stack", "我再想了一下（演示）：后进的要等先进的先弹出去。",
         "演示讲解：不是。后进的最先弹出去，先进的还在下面。"),
    )))
    queue_id = store.create_thread(
        student_id, subject.id, title=queue_title, anchor_message_id=messages["ds-u2"],
        client_request_id="seed-demo-ds-thread-queue",
    )
    messages.update(_turns(store, queue_id, (
        ("ds-t-queue", "我还是觉得牺牲一个单元这种说法是多余的（演示）。",
         "演示讲解：不多余。空出一个单元后，(rear+1) 模容量等于 front 才是队满，front 等于 rear 仍是队空。"),
    )))
    hash_id = store.create_thread(
        student_id, subject.id, title=hash_title, anchor_message_id=messages["ds-u4"],
        client_request_id="seed-demo-ds-thread-hash",
    )
    messages.update(_turns(store, hash_id, (
        ("ds-t-hash", "冲突就应该换一个哈希函数重写（演示）。链地址法是不是没用？",
         "演示讲解：先别换函数。链地址法是在同一槽后面挂一个链表，开放定址是按规则探下一个空槽。这一条还没结束。"),
    )))
    observations = (
        {"key": "ds-u1", "kind": "misconception", "topic": "栈的后进先出（演示）", "topic_key": "stack.lifo",
         "summary": "把栈记成先进先出。", "quote": "栈是先进先出的", "reason": "主对话原话把栈说成先进先出",
         "signal": "supports", "tags": ["栈", "LIFO", "演示"]},
        {"key": "ds-t-stack", "kind": "misconception", "topic": "栈的后进先出（演示）", "topic_key": "stack.lifo",
         "summary": "把栈记成先进先出。", "quote": "后进的要等先进的先弹出去", "reason": "Thread 里仍认为后进的要等先进的",
         "signal": "supports", "tags": ["栈", "LIFO", "演示"]},
        {"key": "ds-u2", "kind": "misconception", "topic": "循环队列判满（演示）", "topic_key": "queue.circular.full",
         "summary": "认为队满和队空都只看 front 等于 rear。", "quote": "循环队列队满和队空都是 front 等于 rear",
         "reason": "原话无法区分队满和队空", "signal": "supports", "tags": ["队列", "循环队列", "演示"]},
        {"key": "ds-t-queue", "kind": "misconception", "topic": "循环队列判满（演示）", "topic_key": "queue.circular.full",
         "summary": "认为队满和队空都只看 front 等于 rear。", "quote": "牺牲一个单元这种说法是多余的",
         "reason": "原话否定了空一个单元的判满办法", "signal": "supports", "tags": ["队列", "循环队列", "演示"]},
        {"key": "ds-u3", "kind": "misconception", "topic": "二叉树中序遍历（演示）", "topic_key": "tree.inorder",
         "summary": "把中序遍历记成先根再左再右。", "quote": "中序遍历是先访问根，再左子树，再右子树",
         "reason": "原话把中序说成了前序", "signal": "supports", "tags": ["二叉树", "遍历", "演示"]},
        {"key": "ds-u4", "kind": "misconception", "topic": "哈希冲突（演示）", "topic_key": "hash.collision",
         "summary": "把哈希冲突理解成哈希函数写错。", "quote": "不同键算出同一个值说明哈希函数坏了",
         "reason": "原话把正常冲突当成函数损坏", "signal": "supports", "tags": ["哈希", "冲突", "演示"]},
        {"key": "ds-t-hash", "kind": "misconception", "topic": "哈希冲突（演示）", "topic_key": "hash.collision",
         "summary": "把哈希冲突理解成哈希函数写错。", "quote": "冲突就应该换一个哈希函数重写",
         "reason": "Thread 里仍主张冲突就要重写函数", "signal": "supports", "tags": ["哈希", "冲突", "演示"]},
        {"key": "ds-u5", "kind": "misconception", "topic": "递归与系统栈（演示）", "topic_key": "recursion.stack",
         "summary": "认为递归不占用栈空间。", "quote": "递归调用不会占用栈空间",
         "reason": "原话否认递归使用系统栈", "signal": "supports", "tags": ["递归", "栈", "演示"]},
        {"key": "ds-u8", "kind": "misconception", "topic": "递归与系统栈（演示）", "topic_key": "recursion.stack",
         "summary": "认为递归不占用栈空间。", "quote": "递归返回时也会一层层从系统栈弹出",
         "reason": "后来的原话改成了返回时弹栈", "signal": "contradicts", "tags": ["递归", "栈", "演示"]},
        {"key": "ds-u6", "kind": "mastery", "topic": "顺序栈的 top 移动（演示）", "topic_key": "stack.top",
         "summary": "能说清入栈先移动 top 再写入，出栈先读再回退 top。",
         "quote": "顺序栈入栈是 top 加一后写入，出栈是先读再 top 减一",
         "reason": "原话与顺序栈操作一致", "signal": "supports", "tags": ["栈", "顺序栈", "演示"]},
        {"key": "ds-u7", "kind": "mastery", "topic": "队列的进出端（演示）", "topic_key": "queue.fifo",
         "summary": "能区分队头删除和队尾插入。", "quote": "队列是先进先出，队头删除，队尾插入",
         "reason": "原话正确区分了队列两端", "signal": "supports", "tags": ["队列", "FIFO", "演示"]},
        {"key": "ds-u3", "kind": "mastery", "topic": "完全二叉树编号（演示）", "topic_key": "tree.complete.index",
         "summary": "能用层序编号推出左右孩子。", "quote": "完全二叉树按层编号，左孩子是 2i，右孩子是 2i+1",
         "reason": "原话的孩子编号正确", "signal": "supports", "tags": ["二叉树", "编号", "演示"]},
    )
    for spec in observations:
        _observe(store, student_id, subject.id, messages, spec)
    _resolve(store, student_id, stack_id, stack_title,
             "演示结论：栈是后进先出，最后压入的元素最先弹出，不能按队列来记。",
             ["用叠盘子记 LIFO，后放下的先拿走", "顺序栈出栈要先读栈顶，再让 top 减一"])
    _resolve(store, student_id, queue_id, queue_title,
             "演示结论：循环队列若只看 front 等于 rear，队空和队满无法区分；牺牲一个单元后可以用 (rear+1) 模容量等于 front 表示队满。",
             ["队空仍然是 front 等于 rear", "队满可以用空一个单元，或另记元素个数"])


def _seed_circuit(store: ChatStore, student_id: str, deadline: str) -> None:
    subject = _ensure_subject(
        store, student_id, name=CIRCUIT_NAME, description=CIRCUIT_DESCRIPTION,
        instructions="演示多空间时用，只保留少量电路易错点。",
        goal="把电位方向和节点电流守恒讲清楚（演示）",
        level="some", deadline=deadline, color="#0f6e56", request_id=CIRCUIT_MAIN,
    )
    messages = _turns(store, subject.main_conversation_id, (
        ("circuit-u1", "演示一下电路：我总觉得电流从低电位流向高电位。",
         "演示讲解：在电源外部，电流从高电位流向低电位。低电位流向高电位是电源内部由非静电力完成的。"),
        ("circuit-u2", "基尔霍夫电流定律我能写对（演示）：流入节点的电流之和等于流出之和。",
         "演示讲解：对。节点上电流代数和为零，流入等于流出。"),
    ))
    thread_id = store.create_thread(
        student_id, subject.id, title="串联分压（演示）", anchor_message_id=messages["circuit-u1"],
        client_request_id="seed-demo-circuit-thread-divider",
    )
    _turns(store, thread_id, (
        ("circuit-t1", "串联分压是按电阻比例分，还是按电流分？（演示）",
         "演示讲解：串联电流相同，电压按电阻比例分。这条还在看例子。"),
    ))
    for spec in (
        {"key": "circuit-u1", "kind": "misconception", "topic": "电位与电流方向（演示）", "topic_key": "circuit.direction",
         "summary": "认为电流总是从低电位流向高电位。", "quote": "电流从低电位流向高电位",
         "reason": "原话把电源外部的电流方向说反了", "signal": "supports", "tags": ["电路", "电位", "演示"]},
        {"key": "circuit-u2", "kind": "mastery", "topic": "节点电流守恒（演示）", "topic_key": "circuit.kcl",
         "summary": "能写出流入节点的电流等于流出的电流。", "quote": "流入节点的电流之和等于流出之和",
         "reason": "原话与基尔霍夫电流定律一致", "signal": "supports", "tags": ["电路", "KCL", "演示"]},
    ):
        _observe(store, student_id, subject.id, messages, spec)


def seed(path: Path, student_id: str) -> None:
    store = open_store(path)
    today = date.today()
    _seed_data_structures(store, student_id, (today + timedelta(days=10)).isoformat())
    _seed_circuit(store, student_id, (today + timedelta(days=21)).isoformat())
    _seed_profile(store, student_id)
    seed_agenda(store, student_id)
    seed_focus(store, student_id)


def _seed_subject_ids(db, student_id: str) -> list[str]:
    rows = db.execute(
        "SELECT id, subject_id FROM conversations WHERE student_id = ? AND client_request_id LIKE ?",
        (student_id, f"{REQUEST_PREFIX}%"),
    ).fetchall()
    subject_ids = {row["subject_id"] for row in rows if row["subject_id"]}
    conversation_ids = [row["id"] for row in rows]
    if conversation_ids:
        placeholders = ",".join("?" * len(conversation_ids))
        more = db.execute(
            f"SELECT id FROM subjects WHERE student_id = ? AND main_conversation_id IN ({placeholders})",
            (student_id, *conversation_ids),
        ).fetchall()
        subject_ids.update(row["id"] for row in more)
    return list(subject_ids)


def reset(path: Path, student_id: str) -> None:
    store = open_store(path)
    with store.connection() as db:
        db.execute("BEGIN IMMEDIATE")
        subject_ids = _seed_subject_ids(db, student_id)
        _reset_agenda_and_focus(db, student_id, subject_ids)
        if subject_ids:
            placeholders = ",".join("?" * len(subject_ids))
            db.execute(
                f"DELETE FROM learner_memories WHERE student_id = ? AND subject_id IN ({placeholders})",
                (student_id, *subject_ids),
            )
            db.execute(
                f"DELETE FROM conversations WHERE student_id = ? AND (subject_id IN ({placeholders}) OR client_request_id LIKE ?)",
                (student_id, *subject_ids, f"{REQUEST_PREFIX}%"),
            )
            db.execute(
                f"DELETE FROM subjects WHERE student_id = ? AND id IN ({placeholders})",
                (student_id, *subject_ids),
            )
        else:
            db.execute(
                "DELETE FROM conversations WHERE student_id = ? AND client_request_id LIKE ?",
                (student_id, f"{REQUEST_PREFIX}%"),
            )
    _clear_profile(store, student_id)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="导入或清除 KnowGap 演示数据")
    parser.add_argument("--db", help="SQLite 文件路径，或桌面版 userData 目录（使用其中的 knowgap.sqlite3）")
    parser.add_argument("--student", default=DEMO_STUDENT, help="默认 demo-student-001")
    parser.add_argument("--reset", action="store_true", help="只删除本脚本写入的演示数据")
    args = parser.parse_args(argv)
    path = resolve_db(args.db)
    if args.reset:
        reset(path, args.student)
        print(f"reset {path}")
    else:
        seed(path, args.student)
        print(f"seeded {path}")


if __name__ == "__main__":
    main()
