"""代码实验台（code_playground）的运行记录：学生每跑一次，下一轮 AI 就知道他写了什么、跑成什么样。

回复定稿时 `seal_playgrounds` 给每个实验台编号（playgroundId 写回正文里的微件 JSON），
并在 playground_items 里存标题和语言。前端每次运行完上报一份摘要（状态、通过数、第一条报错、
代码），存进 playground_runs。下一轮由 `run_context` 整理成 turn_context.code_runs：
每个实验台只带最近一次的代码和报错，外加历次状态的走向，控制 token。

沙盒接口本身不变、不落库；记录只随会话删除，重新生成时旧回复不在历史里，自然不再带给模型。
"""

import json
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import Field

from app.auth.deps import current_student
from app.chat.quizzes import seal_quizzes
from app.chat.schemas import StrictModel
from app.chat.skills.problem_drill_skill import WIDGET_RE
from app.memory.store import new_id, now

RunStatus = Literal["passed", "ok", "failed", "compile_error", "runtime_error", "timeout", "blocked"]

STATUS_LABELS = {
    "passed": "全部通过", "ok": "运行完成", "failed": "输出和预期不一致", "compile_error": "编译或语法错误",
    "runtime_error": "运行出错", "timeout": "运行超时", "blocked": "被安全规则拦截",
}

CODE_LIMIT = 20_000         # 与沙盒上限一致：存全，打开实验台时能原样恢复
CONTEXT_CODE_LIMIT = 3_000  # 带给模型的代码
TEXT_LIMIT = 1_000          # 报错、输出
CONTEXT_PLAYGROUNDS = 3     # 每轮最多带几个实验台
TRAIL_LIMIT = 8             # 状态走向最多记几次


def _clip(value: str | None, limit: int) -> str:
    text = (value or "").strip()
    return text if len(text) <= limit else text[:limit] + "…（已截断）"


def seal_playgrounds(text: str, message_id: str, conversation_id: str, store) -> str:
    """给回复里的 code_playground 加 playgroundId 并登记；解析不了的块原样保留。"""
    sealed: list[tuple] = []
    pieces: list[str] = []
    cursor = 0
    for match in WIDGET_RE.finditer(text or ""):
        try:
            widget = json.loads(match.group(1))
        except ValueError:
            continue
        if not isinstance(widget, dict) or widget.get("type") != "code_playground":
            continue
        language = str(widget.get("language") or "").strip().lower()
        playground_id = f"{message_id}:p{len(sealed)}"
        title = str(widget.get("title") or "").strip()[:80] or "代码实验台"
        sealed.append((playground_id, message_id, conversation_id, title, language[:20], now()))
        widget["playgroundId"] = playground_id
        pieces.append(text[cursor:match.start(1)])
        pieces.append(json.dumps(widget, ensure_ascii=False))
        cursor = match.end(1)
    if not sealed:
        return text
    pieces.append(text[cursor:])
    with store.connection() as db:
        db.executemany("""
            INSERT INTO playground_items(playground_id, message_id, conversation_id, title, language, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(playground_id) DO UPDATE SET title = excluded.title, language = excluded.language
        """, sealed)
    return "".join(pieces)


class FailedCase(StrictModel):
    name: str = Field(default="", max_length=200)
    input: str = Field(default="", max_length=20_000)
    expected: str | None = Field(default=None, max_length=20_000)
    actual: str = Field(default="", max_length=20_000)


class RunReport(StrictModel):
    status: RunStatus
    passed: int = Field(default=0, ge=0, le=100)
    total: int = Field(default=0, ge=0, le=100)
    code: str = Field(min_length=1, max_length=CODE_LIMIT)
    stdin: str = Field(default="", max_length=20_000)
    error_line: int | None = Field(default=None, ge=1)
    error_message: str = Field(default="", max_length=20_000)
    stdout: str = Field(default="", max_length=20_000)
    stderr: str = Field(default="", max_length=20_000)
    failed_case: FailedCase | None = None


def _detail(report: RunReport) -> dict:
    detail: dict = {}
    if report.error_message.strip():
        detail["error"] = {"line": report.error_line, "message": _clip(report.error_message, TEXT_LIMIT)}
    for key in ("stdout", "stderr", "stdin"):
        value = _clip(getattr(report, key), TEXT_LIMIT)
        if value:
            detail[key] = value
    if report.failed_case is not None:
        case = report.failed_case
        detail["failed_case"] = {
            "name": _clip(case.name, 60), "input": _clip(case.input, 300),
            "expected": None if case.expected is None else _clip(case.expected, 300),
            "actual": _clip(case.actual, 300),
        }
    return detail


def _public(run) -> dict:
    return {
        "id": run["id"], "playground_id": run["playground_id"], "status": run["status"],
        "passed": run["passed"], "total": run["total"], "code": run["code"],
        "detail": json.loads(run["detail_json"]), "created_at": run["created_at"],
    }


class PlaygroundStore:
    def __init__(self, store):
        self.store = store

    def record(self, playground_id: str, student_id: str, report: RunReport) -> dict:
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            item = db.execute(
                "SELECT p.* FROM playground_items p JOIN conversations c ON c.id = p.conversation_id "
                "WHERE p.playground_id = ? AND c.student_id = ?", (playground_id, student_id),
            ).fetchone()
            if item is None:
                raise LookupError("代码实验台不存在")
            run_id = new_id("pr")
            passed = min(report.passed, report.total)
            db.execute(
                "INSERT INTO playground_runs(id, playground_id, conversation_id, status, passed, total, code, "
                "detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (run_id, playground_id, item["conversation_id"], report.status, passed, report.total,
                 report.code, json.dumps(_detail(report), ensure_ascii=False), now()),
            )
            return _public(db.execute("SELECT * FROM playground_runs WHERE id = ?", (run_id,)).fetchone())

    def latest_runs(self, conversation_id: str, student_id: str) -> dict:
        """每个实验台最近一次运行，前端打开时据此恢复代码和结果。"""
        with self.store.connection() as db:
            if not db.execute("SELECT 1 FROM conversations WHERE id = ? AND student_id = ?",
                              (conversation_id, student_id)).fetchone():
                raise LookupError("对话不存在")
            rows = db.execute(
                "SELECT r.* FROM playground_runs r WHERE r.conversation_id = ? "
                "ORDER BY r.created_at, r.rowid", (conversation_id,),
            ).fetchall()
        return {row["playground_id"]: _public(row) for row in rows}

    def run_context(
        self, conversation_id: str, student_id: str, message_ids: set[str] | None = None,
        limit: int = CONTEXT_PLAYGROUNDS,
    ) -> list[dict]:
        """turn_context.code_runs：最近动过的几个实验台，按最后运行时间排列（最新在后）。"""
        with self.store.connection() as db:
            rows = db.execute(
                "SELECT r.rowid AS seq, r.*, p.title, p.language, p.message_id FROM playground_runs r "
                "JOIN playground_items p ON p.playground_id = r.playground_id "
                "JOIN conversations c ON c.id = p.conversation_id "
                "WHERE r.conversation_id = ? AND c.student_id = ? ORDER BY r.created_at, r.rowid",
                (conversation_id, student_id),
            ).fetchall()
        grouped: dict[str, list] = {}
        for row in rows:
            if message_ids is not None and row["message_id"] not in message_ids:
                continue
            grouped.setdefault(row["playground_id"], []).append(row)
        # 按最后一次运行排序后取最近的几个
        ordered = sorted(grouped.values(), key=lambda runs: (runs[-1]["created_at"], runs[-1]["seq"]))[-limit:]
        picked = []
        for runs in ordered:
            latest = runs[-1]
            detail = json.loads(latest["detail_json"])
            item = {
                "playground_id": latest["playground_id"],
                "title": latest["title"],
                "language": latest["language"],
                "runs": len(runs),
                "trail": [_trail(run) for run in runs[-TRAIL_LIMIT:]],
                "latest_status": STATUS_LABELS.get(latest["status"], latest["status"]),
                "solved": latest["status"] == "passed" or any(run["status"] == "passed" for run in runs),
                "latest_code": _clip(latest["code"], CONTEXT_CODE_LIMIT),
            }
            if latest["total"]:
                item["latest_passed"] = f"{latest['passed']}/{latest['total']}"
            for key in ("error", "failed_case", "stdout", "stderr"):
                if key in detail:
                    item[f"latest_{key}"] = detail[key]
            picked.append(item)
        return picked


def _trail(run) -> str:
    label = STATUS_LABELS.get(run["status"], run["status"])
    return f"{label} {run['passed']}/{run['total']}" if run["total"] else label


def playground_router(store) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["代码实验台"])
    playgrounds = PlaygroundStore(store)

    @router.post("/playgrounds/{playground_id}/runs")
    def record_run(playground_id: str, body: RunReport):
        try:
            return playgrounds.record(playground_id, current_student(), body)
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from exc

    @router.get("/conversations/{conversation_id}/playground-runs")
    def latest_runs(conversation_id: str):
        try:
            return playgrounds.latest_runs(conversation_id, current_student())
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from exc

    return router


def seal_cards(text: str, message_id: str, conversation_id: str, store) -> str:
    """回复定稿时封存需要服务端记录的卡片：小测（抹掉答案）和代码实验台（编号）。"""
    return seal_playgrounds(seal_quizzes(text, message_id, conversation_id, store), message_id, conversation_id, store)
