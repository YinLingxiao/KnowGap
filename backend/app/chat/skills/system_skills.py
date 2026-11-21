"""系统技能：读、做常用文件（PDF / Word / PPT / Excel）的具体做法。

每个技能一份 YAML（skills/system/*.yaml），随桌面版一起打包，始终可用。模型通过 load_skill 工具按需加载全文，
工具说明里只列出名称和用途，不占每轮的提示长度。「设置 → 技能」里可以查看，但不能关闭。
"""

from functools import lru_cache
from pathlib import Path

import yaml

TOOL_NAME = "load_skill"
SKILL_DIR = Path(__file__).parent / "system"
CATEGORIES = ("read", "make")
ORDER = ("read_pdf", "read_docx", "read_pptx", "read_xlsx", "make_docx", "make_pptx", "make_xlsx", "make_pdf")
_FIELDS = ("id", "category", "name", "name_en", "summary", "summary_en", "content")


@lru_cache(maxsize=1)
def catalog() -> tuple[dict, ...]:
    items = []
    for path in SKILL_DIR.glob("*.yaml"):
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        missing = [key for key in _FIELDS if not str(data.get(key) or "").strip()]
        if missing or data["category"] not in CATEGORIES or data["id"] != path.stem:
            raise ValueError(f"系统技能 {path.name} 不完整：{missing or data.get('category') or data.get('id')}")
        items.append({key: str(data[key]).strip() for key in _FIELDS})
    rank = {skill_id: index for index, skill_id in enumerate(ORDER)}
    return tuple(sorted(items, key=lambda item: (rank.get(item["id"], len(ORDER)), item["id"])))


def by_id(skill_id: str) -> dict | None:
    return next((item for item in catalog() if item["id"] == skill_id), None)


def definition() -> dict:
    skills = catalog()
    lines = "\n".join(f"- {item['id']}：{item['name']}——{item['summary']}" for item in skills)
    return {
        "type": "function",
        "function": {
            "name": TOOL_NAME,
            "description": (
                "加载一个系统技能，拿到处理某类文件的详细做法：怎么读、怎么引用位置、怎么用 create_document / edit_document 生成或修改。"
                "要读、总结、讲解、修改或生成下列文件时，先加载对应的技能再动手；同一对话里已经加载过的不用重复加载。"
                f"可用技能：\n{lines}"
            ),
            "parameters": {
                "type": "object",
                "properties": {"skill": {"type": "string", "enum": [item["id"] for item in skills]}},
                "required": ["skill"],
                "additionalProperties": False,
            },
        },
    }


def run(arguments: dict, _ctx=None) -> str:
    skill = by_id(str(arguments.get("skill") or "").strip())
    if skill is None:
        available = "、".join(item["id"] for item in catalog())
        return f"没有技能「{arguments.get('skill')}」。可用的技能：{available}。"
    return skill["content"]
