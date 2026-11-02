"""micro_quiz 封存与作答：答案只留在服务端，前端提交选项后由这里判分并记录。

回复定稿时 `seal_quizzes` 把题目存进 quiz_items，并把正文里的代码块改写成不含
answerIndex / explanation、带 quizId 的版本。作答记录（quiz_attempts）与题目不随重新生成删除。
"""

import json
import sqlite3

from fastapi import APIRouter, HTTPException

from app.auth.deps import current_student
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


def seal_quizzes(text: str, message_id: str, conversation_id: str, store) -> str:
    """把回复里的 micro_quiz 存进 quiz_items 并抹掉答案；解析不了的块原样保留。"""
    sealed: list[tuple] = []
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
        sealed.append((
            quiz_id, message_id, conversation_id, widget["question"],
            json.dumps(widget["options"], ensure_ascii=False), widget["answerIndex"],
            str(widget.get("explanation") or ""),
            json.dumps(widget.get("meta") if isinstance(widget.get("meta"), dict) else {}, ensure_ascii=False),
            now(),
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
                                   explanation, meta_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(quiz_id) DO UPDATE SET question = excluded.question, options_json = excluded.options_json,
                answer_index = excluded.answer_index, explanation = excluded.explanation, meta_json = excluded.meta_json
        """, sealed)
    return "".join(pieces)


def _result(quiz: sqlite3.Row, attempt: sqlite3.Row, repeated: bool = False) -> dict:
    result = {
        "quiz_id": quiz["quiz_id"], "attempt_id": attempt["id"], "option_index": attempt["option_index"],
        "correct": bool(attempt["correct"]), "answer_index": quiz["answer_index"], "explanation": quiz["explanation"],
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
            return _result(quiz, db.execute("SELECT * FROM quiz_attempts WHERE id = ?", (attempt_id,)).fetchone())

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
