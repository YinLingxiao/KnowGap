import json
from pathlib import Path

from app.config import Settings
from app.models.schemas import TutorOutput

ROOT = Path(__file__).resolve().parents[2]
CASES = json.loads((ROOT / "demo" / "stack_sequences.json").read_text(encoding="utf-8"))


def isolated_settings(tmp_path, **kwargs):
    return Settings(
        _env_file=None,
        database_path=tmp_path / "acceptance.sqlite3",
        llm_api_key="",
        llm_base_url="",
        llm_model="",
        **kwargs,
    )


class RubricDouble:
    def __init__(self, steps):
        self.steps = iter(steps)
        self.contexts = []

    async def generate(self, context):
        self.contexts.append(context)
        step = next(self.steps)
        evidence = step["evidence"]
        if evidence not in context["current_answer"]:
            raise AssertionError("acceptance fixture evidence is not a verbatim quote")
        memories = context["related_memories"]
        reply = step["reply_with_memory"] if memories and step.get("reply_with_memory") else step["reply"]
        return TutorOutput(
            assessment=step["assessment"],
            issue=step.get("issue"),
            confidence=step.get("confidence", 0.7),
            evidence=evidence,
            reply=reply,
        )


def step_from_answer(answer, reply, reply_with_memory=None):
    item = {
        "assessment": answer["rubric"],
        "evidence": answer["evidence"],
        "reply": reply,
    }
    if answer["rubric"] == "incorrect":
        item["issue"] = answer["issue"]
    if reply_with_memory:
        item["reply_with_memory"] = reply_with_memory
    return item


def problem_case(problem_id):
    return next(item for item in CASES["problems"] if item["id"] == problem_id)
