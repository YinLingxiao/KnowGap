"""micro_quiz 封存与作答：答案只留在服务端，前端提交选项后由这里判分并记录。

回复定稿时 `seal_quizzes` 把题目存进 quiz_items，并把正文里的代码块改写成不含
answerIndex / explanation、带 quizId 的版本。作答记录（quiz_attempts）与题目不随重新生成删除。
"""

import json
import re
import sqlite3

from fastapi import APIRouter, HTTPException

from app.auth.deps import current_student
from app.chat.plan import PlanStore
from app.chat.schemas import StrictModel
from app.chat.skills.problem_drill_skill import WIDGET_RE
from app.memory.store import new_id, now


class QuizConflict(Exception):
    """同一个 action_id 带着不同的内容再次提交。"""


def _valid_quiz(widget) -> bool:
    if not isinstance(widget, dict) or widget.get("type") != "micro_quiz":
        return False
    options, answer = widget.get("options"), widget.get("answerIndex")
    return (isinstance(widget.get("question"), str) and isinstance(options, list) and len(options) >= 2
            and isinstance(answer, int) and not isinstance(answer, bool) and 0 <= answer < len(options))


GAP_NOTE_LIMIT = 120


def guard_gaps(text: str, allowed_misconceptions: set[str]) -> str:
    """删掉 memoryId 不是该学生误区记忆的 gap 卡；note 截断到 120 字。"""
    def fix(match: re.Match) -> str:
        try:
            widget = json.loads(match.group(1))
        except ValueError:
            return match.group(0)
        if not isinstance(widget, dict) or widget.get("type") != "gap":
            return match.group(0)
        if widget.get("memoryId") not in allowed_misconceptions:
            return ""
        note = widget.get("note")
        if isinstance(note, str) and len(note) > GAP_NOTE_LIMIT:
            widget["note"] = note[:GAP_NOTE_LIMIT]
        elif not isinstance(note, str):
            widget.pop("note", None)
        return match.group(0)[:match.start(1) - match.start()] + json.dumps(widget, ensure_ascii=False)             + match.group(0)[match.end(1) - match.start():]
    return WIDGET_RE.sub(fix, text or "")


def _awaiting_step_ids(db, conversation_id: str, store) -> set[str]:
    PlanStore(store)._ensure(db)
    row = db.execute("SELECT steps_json FROM conversation_plans WHERE conversation_id = ?", (conversation_id,)).fetchone()
    steps = json.loads(row["steps_json"]) if row else []
    return {step["id"] for step in steps if step.get("status") == "awaiting_learner"}


def seal_quizzes(text: str, message_id: str, conversation_id: str, store) -> str:
    """把回复里的 micro_quiz 存进 quiz_items 并抹掉答案；解析不了的块原样保留。"""
    sealed: list[tuple] = []
    awaiting: set[str] | None = None
    pieces: list[str] = []
    cursor = 0
    for match in WIDGET_RE.finditer(text or ""):
        try:
            widget = json.loads(match.group(1))
        except ValueError:
            continue
        if not _valid_quiz(widget):
            continue
        quiz_id = f"{message_id}:{len(sealed)}"
        step_id = widget.get("planStepId")
        if isinstance(step_id, str) and step_id:  # 只有会话计划里确在等学习者作答的步骤才挂钩
            if awaiting is None:
                with store.connection() as db:
                    awaiting = _awaiting_step_ids(db, conversation_id, store)
            step_id = step_id if step_id in awaiting else None
        else:
            step_id = None
        sealed.append((
            quiz_id, message_id, conversation_id, widget["question"],
            json.dumps(widget["options"], ensure_ascii=False), widget["answerIndex"],
            str(widget.get("explanation") or ""),
            json.dumps(widget.get("meta") if isinstance(widget.get("meta"), dict) else {}, ensure_ascii=False),
            now(), step_id,
        ))
        public = {key: value for key, value in widget.items() if key not in ("answerIndex", "explanation")}
        public["quizId"] = quiz_id
        pieces.append(text[cursor:match.start(1)])
        pieces.append(json.dumps(public, ensure_ascii=False))
        cursor = match.end(1)
    if not sealed:
        return text
    pieces.append(text[cursor:])
    with store.connection() as db:
        db.executemany("""
            INSERT INTO quiz_items(quiz_id, message_id, conversation_id, question, options_json, answer_index,
                                   explanation, meta_json, created_at, plan_step_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(quiz_id) DO UPDATE SET question = excluded.question, options_json = excluded.options_json,
                answer_index = excluded.answer_index, explanation = excluded.explanation, meta_json = excluded.meta_json,
                plan_step_id = excluded.plan_step_id
        """, sealed)
    return "".join(pieces)


def _result(quiz: sqlite3.Row, attempt: sqlite3.Row, repeated: bool = False,
            memory_changes: list | None = None, plan_step: dict | None = None) -> dict:
    result = {
        "quiz_id": quiz["quiz_id"], "attempt_id": attempt["id"], "option_index": attempt["option_index"],
        "correct": bool(attempt["correct"]), "answer_index": quiz["answer_index"], "explanation": quiz["explanation"],
        "memory_changes": memory_changes or [], "plan_step": plan_step,
    }
    if repeated:
        result["repeated"] = True
    return result


class QuizStore:
    def __init__(self, store):
        self.store = store

    def submit(self, quiz_id: str, student_id: str, action_id: str, option_index: int) -> dict:
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            quiz = db.execute(
                "SELECT q.* FROM quiz_items q JOIN conversations c ON c.id = q.conversation_id "
                "WHERE q.quiz_id = ? AND c.student_id = ?", (quiz_id, student_id),
            ).fetchone()
            if quiz is None:
                raise LookupError("题目不存在")
            if not 0 <= option_index < len(json.loads(quiz["options_json"])):
                raise ValueError("选项序号超出范围")
            same_action = db.execute("SELECT * FROM quiz_attempts WHERE action_id = ?", (action_id,)).fetchone()
            if same_action is not None:
                if same_action["quiz_id"] != quiz_id or same_action["option_index"] != option_index:
                    raise QuizConflict("同一个 actionId 的提交内容不一致")
                return _result(quiz, same_action)
            first = db.execute("SELECT * FROM quiz_attempts WHERE quiz_id = ?", (quiz_id,)).fetchone()
            if first is not None:  # 每题只记第一次作答
                return _result(quiz, first, repeated=True)
            attempt_id = new_id("qa")
            db.execute(
                "INSERT INTO quiz_attempts(id, action_id, quiz_id, conversation_id, option_index, correct, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (attempt_id, action_id, quiz_id, quiz["conversation_id"], option_index,
                 int(option_index == quiz["answer_index"]), now()),
            )
            correct = option_index == quiz["answer_index"]
            memory_changes = self._record_evidence(db, quiz, student_id, attempt_id, option_index, correct)
            plan_step = None
            if correct and quiz["plan_step_id"]:
                plan_step = PlanStore(self.store).complete_awaiting_step(
                    db, quiz["conversation_id"], student_id, quiz["plan_step_id"], quiz["message_id"])
            return _result(quiz, db.execute("SELECT * FROM quiz_attempts WHERE id = ?", (attempt_id,)).fetchone(),
                           memory_changes=memory_changes, plan_step=plan_step)

    def _record_evidence(self, db, quiz, student_id: str, attempt_id: str, option_index: int, correct: bool) -> list:
        """选错 → 所选选项对应的误区 supports；答对 → 题目针对的误区 contradicts。"""
        meta = json.loads(quiz["meta_json"])
        if correct:
            memory_ids = [m for m in meta.get("target_misconceptions") or [] if isinstance(m, str)]
        else:
            mapping = meta.get("option_misconceptions")
            chosen = mapping[option_index] if isinstance(mapping, list) and option_index < len(mapping) else None
            memory_ids = [chosen] if isinstance(chosen, str) else []
        if not memory_ids:
            return []
        option = json.loads(quiz["options_json"])[option_index]
        changes = []
        for memory_id in dict.fromkeys(memory_ids):
            change = self.store.record_quiz_evidence(
                db, student_id, memory_id, signal="contradicts" if correct else "supports",
                quote=f"题目：{quiz['question']}｜所选：{option}", reason="来自测验作答",
                conversation_id=quiz["conversation_id"], attempt_id=attempt_id)
            if change:
                changes.append(change.model_dump(mode="json"))
        return changes

    def list_attempts(self, conversation_id: str, student_id: str) -> dict:
        with self.store.connection() as db:
            if not db.execute("SELECT 1 FROM conversations WHERE id = ? AND student_id = ?",
                              (conversation_id, student_id)).fetchone():
                raise LookupError("对话不存在")
            rows = db.execute(
                "SELECT q.quiz_id, q.answer_index, q.explanation, a.id AS attempt_id, a.option_index, a.correct "
                "FROM quiz_attempts a JOIN quiz_items q ON q.quiz_id = a.quiz_id "
                "WHERE a.conversation_id = ? ORDER BY a.created_at", (conversation_id,),
            ).fetchall()
            return {row["quiz_id"]: _result(row, {"id": row["attempt_id"], "option_index": row["option_index"],
                                                    "correct": row["correct"]}) for row in rows}


class AttemptBody(StrictModel):
    action_id: str
    option_index: int


def quiz_router(store) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["微测"])
    quizzes = QuizStore(store)

    @router.post("/quizzes/{quiz_id}/attempts")
    def submit_attempt(quiz_id: str, body: AttemptBody):
        if not 1 <= len(body.action_id) <= 100:
            raise HTTPException(422, "actionId 长度不合法")
        try:
            return quizzes.submit(quiz_id, current_student(), body.action_id, body.option_index)
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except QuizConflict as exc:
            raise HTTPException(409, str(exc)) from exc

    @router.get("/conversations/{conversation_id}/quiz-attempts")
    def list_attempts(conversation_id: str):
        try:
            return quizzes.list_attempts(conversation_id, current_student())
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from exc

    return router
