"""代码实验台的运行记录：定稿时编号、上报运行、打开时恢复、下一轮带给 AI 和学习分析。"""

import json

from fastapi.testclient import TestClient

from app.chat.agent import learning_context
from app.chat.playgrounds import CONTEXT_CODE_LIMIT, seal_cards, seal_playgrounds
from app.chat.store import ChatStore
from app.main import create_app
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import FakeChat, send

PLAYGROUND = {
    "type": "code_playground", "title": "补全：求平方", "language": "python", "mode": "scaffold",
    "starter_code": "n = int(input())\n# TODO: 计算平方\nprint(result)",
    "test_cases": [{"name": "用例1", "input": "3", "expected": "9"}, {"name": "用例2", "input": "-4", "expected": "16"}],
}
QUIZ = {"type": "micro_quiz", "question": "栈的出栈顺序？", "options": ["先进先出", "后进先出"], "answerIndex": 1}


def block(widget) -> str:
    return "```knowgap-widget\n" + json.dumps(widget, ensure_ascii=False) + "\n```"


def widgets(text: str) -> list[dict]:
    from app.chat.skills.problem_drill_skill import WIDGET_RE
    return [json.loads(m.group(1)) for m in WIDGET_RE.finditer(text)]


def setup(client):
    """当前学生的会话里有一条助手回复：一个实验台、一道小测、一个坏块。"""
    conversation = client.post("/api/conversations", json={"title": "平方"}).json()["id"]
    store = ChatStore(client.app.state.store)
    user = store.add_user_message(conversation, "出个代码题", "req-pg-001")
    reply = store.start_reply(conversation, user, [])
    text = f"先写代码：\n{block(PLAYGROUND)}\n坏块：\n```knowgap-widget\n{{oops\n```\n再答题：\n{block(QUIZ)}\n"
    sealed = seal_cards(text, reply, conversation, store)
    store.finish_reply(reply, content=sealed, status="complete")
    return conversation, store, user, reply, sealed


WRONG = {
    "status": "failed", "passed": 1, "total": 2, "code": "n = int(input())\nresult = n * 2\nprint(result)",
    "failed_case": {"name": "用例2", "input": "-4", "expected": "16", "actual": "-8"},
}
SYNTAX = {
    "status": "compile_error", "code": "n = int(input()\nprint(n)",
    "error_line": 1, "error_message": "SyntaxError: '(' was never closed",
}
RIGHT = {"status": "passed", "passed": 2, "total": 2, "code": "n = int(input())\nresult = n * n\nprint(result)"}


def report(client, playground_id, body):
    return client.post(f"/api/playgrounds/{playground_id}/runs", json=body)


def test_seal_numbers_playgrounds_and_keeps_quizzes_sealed(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat([]))) as client:
        conversation, store, _, reply, sealed = setup(client)
        assert "{oops" in sealed
        found = widgets(sealed.replace("{oops", '{"type": "text"}'))
        playground = next(w for w in found if w["type"] == "code_playground")
        quiz = next(w for w in found if w["type"] == "micro_quiz")
        assert playground["playgroundId"] == f"{reply}:p0"
        assert playground["starter_code"] == PLAYGROUND["starter_code"]
        assert "answerIndex" not in quiz and quiz["quizId"] == f"{reply}:0"
        assert seal_playgrounds("没有实验台", "m1", conversation, store) == "没有实验台"


def test_runs_are_recorded_and_the_latest_is_restored(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat([]))) as client:
        conversation, _, _, reply, _ = setup(client)
        playground_id = f"{reply}:p0"
        first = report(client, playground_id, WRONG)
        assert first.status_code == 200, first.text
        assert first.json()["detail"]["failed_case"]["actual"] == "-8"
        report(client, playground_id, RIGHT)
        latest = client.get(f"/api/conversations/{conversation}/playground-runs").json()
        assert list(latest) == [playground_id]
        assert latest[playground_id]["status"] == "passed"
        assert latest[playground_id]["code"] == RIGHT["code"]


def test_bad_reports_and_foreign_playgrounds_are_refused(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat([]))) as client:
        conversation, _, _, reply, _ = setup(client)
        assert report(client, "nope:p0", RIGHT).status_code == 404
        assert report(client, f"{reply}:p0", {**RIGHT, "status": "great"}).status_code == 422
        assert report(client, f"{reply}:p0", {**RIGHT, "code": ""}).status_code == 422
        assert report(client, f"{reply}:p0", {**RIGHT, "surprise": 1}).status_code == 422
        assert client.get("/api/conversations/nope/playground-runs").status_code == 404
        # 通过数不会超过用例数
        assert report(client, f"{reply}:p0", {**RIGHT, "passed": 5}).json()["passed"] == 2


def test_runs_reach_the_next_turn_and_the_learning_analysis(tmp_path):
    model = FakeChat(["先看看。", "第 2 行写成了 n * 2。", "好的。"])
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        conversation, store, user, reply, _ = setup(client)
        send(client, conversation, "我先想想", "req-pg-ctx-1")
        assert "code_runs" not in learning_context(model.calls[0])

        playground_id = f"{reply}:p0"
        report(client, playground_id, SYNTAX)
        report(client, playground_id, WRONG)
        send(client, conversation, "我跑了，怎么还错", "req-pg-ctx-2")
        runs = learning_context(model.calls[1])["code_runs"]
        assert runs == [{
            "playground_id": playground_id,
            "title": "补全：求平方",
            "language": "python",
            "runs": 2,
            "trail": ["编译或语法错误", "输出和预期不一致 1/2"],
            "latest_status": "输出和预期不一致",
            "solved": False,
            "latest_code": WRONG["code"],
            "latest_passed": "1/2",
            "latest_failed_case": {"name": "用例2", "input": "-4", "expected": "16", "actual": "-8"},
        }]
        assert model.analysis_calls[-1]["code_runs"] == runs

        # 重新生成后旧回复不在历史里，它的实验台不再带给模型
        store.start_reply(conversation, user, [reply])
        send(client, conversation, "聊点别的", "req-pg-ctx-3")
        assert "code_runs" not in learning_context(model.calls[2])


def test_context_keeps_only_recent_playgrounds_and_clips_code(tmp_path):
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=FakeChat([]))) as client:
        conversation, store, user, *_ = setup(client)
        ids = []
        for index in range(4):
            reply = store.start_reply(conversation, user, [])
            sealed = seal_cards(block({**PLAYGROUND, "title": f"第{index}题"}), reply, conversation, store)
            store.finish_reply(reply, content=sealed, status="complete")
            ids.append(f"{reply}:p0")
        for playground_id in ids:
            report(client, playground_id, RIGHT)
        report(client, ids[0], {**SYNTAX, "code": "x" * 9000})  # 第 0 题又跑了一次：变成最近的

        from app.chat.playgrounds import PlaygroundStore
        with store.connection() as db:
            student_id = db.execute("SELECT student_id FROM conversations WHERE id = ?", (conversation,)).fetchone()[0]
        context = PlaygroundStore(store).run_context(conversation, student_id)
        assert [item["title"] for item in context] == ["第2题", "第3题", "第0题"]
        latest = context[-1]
        assert latest["solved"] is True and latest["trail"] == ["全部通过 2/2", "编译或语法错误"]
        assert latest["latest_error"] == {"line": 1, "message": "SyntaxError: '(' was never closed"}
        assert len(latest["latest_code"]) <= CONTEXT_CODE_LIMIT + 10
