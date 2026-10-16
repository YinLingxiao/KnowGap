"""Opt-in real-provider exercise/chat intent checks, using synthetic data in a temporary DB.

Run from backend/: .venv/Scripts/python.exe checks/evaluate_live_chat_intent.py
Uses the current local model configuration and makes billable provider requests.
Writes synthetic replies and checks to logs/chat-intent-live-result.json; no credentials.
"""

import json
import re
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.ai_settings import AISettings
from app.services.problems import PROBLEMS, reference_for


def main():
    configured = AISettings(Settings()).current
    results = []
    with TemporaryDirectory(prefix="knowgap-chat-intent-") as temporary:
        settings = configured.model_copy(update={"database_path": Path(temporary) / "test.sqlite3"})
        with TestClient(create_app(settings)) as client:
            def create(problem=None):
                response = client.post("/api/conversations", json={"problem_id": problem} if problem else {})
                response.raise_for_status()
                return response.json()["id"]

            def send(cid, text, label, *, neutral=False, reference=None, hint=False, allow_preference=False):
                response = client.post(f"/api/conversations/{cid}/messages", json={
                    "content": text, "client_request_id": "intent-" + uuid4().hex,
                })
                response.raise_for_status()
                events = []
                for block in response.text.replace("\r\n", "\n").strip().split("\n\n"):
                    lines = block.split("\n")
                    events.append((lines[0].removeprefix("event: "), json.loads(lines[1].removeprefix("data: "))))
                reply = "".join(data["text"] for name, data in events if name == "delta")
                errors = [data for name, data in events if name == "error"]
                tools = [data for name, data in events if name == "tool_end"]
                analysis_skipped = any(name == "analysis" and data.get("skipped") for name, data in events)
                conversation = client.get(f"/api/conversations/{cid}").json()
                user = next(message for message in reversed(conversation["messages"]) if message["role"] == "user")
                checks = {"provider_completed": bool(reply) and not errors}
                if neutral:
                    checks["no_old_exercise"] = re.search(r"栈|push|pop|2\s*,\s*1\s*,\s*4\s*,\s*3", reply, re.I) is None
                    checks["no_reference_lookup"] = not any(tool["name"] == "exercise_reference" for tool in tools)
                    checks["no_false_grade"] = user["attempt"] is None
                    checks["no_false_learning_record"] = not user["memory_changes"] or (
                        allow_preference and all(change["memory"]["kind"] == "preference" for change in user["memory_changes"])
                    )
                if reference:
                    references = [json.loads(tool["output"]) for tool in tools
                                  if tool["name"] == "exercise_reference" and tool["ok"]]
                    expected = {"problem_id": reference, **reference_for(PROBLEMS[reference])}
                    checks["checked_reference_used"] = expected in references
                if hint:
                    checks["hint_is_brief"] = len(reply) < 400 and "|" not in reply
                result = {"case": label, "input": text, "reply": reply, "tools": tools,
                          "attempt": user["attempt"], "errors": errors, "analysis_skipped": analysis_skipped, "checks": checks}
                results.append(result)
                print(json.dumps({"case": label, "checks": checks, "analysis_skipped": analysis_skipped,
                                  "reply": reply[:180]}, ensure_ascii=False), flush=True)

            send(create(), "hi", "plain_greeting", neutral=True)
            for index, greeting in enumerate(("hi", "hi", "你好")):
                send(create("stack-sequence-003"), greeting, f"exercise_greeting_{index}", neutral=True)
            send(create("stack-sequence-003"), "先不做题，英语里 a 和 an 怎么选？用两句话回答。", "change_topic", neutral=True, allow_preference=True)
            send(create("stack-sequence-003"), "这题先别告诉我答案，只给我一个很小的提示。", "hint_only", reference="stack-sequence-003", hint=True)
            solved = create("stack-sequence-003")
            send(solved, "直接告诉我这道题的答案和操作过程", "possible_answer", reference="stack-sequence-003")
            send(solved, "hello", "greeting_after_solution", neutral=True)
            send(create("stack-sequence-001"), "直接告诉我这道题的答案和理由", "impossible_answer", reference="stack-sequence-001")

    report = {"model": configured.llm_model, "results": results}
    output = Path(__file__).resolve().parents[2] / "logs" / "chat-intent-live-result.json"
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    passed = sum(all(item["checks"].values()) for item in results)
    print(f"{passed}/{len(results)} cases passed; report: {output}")
    raise SystemExit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
