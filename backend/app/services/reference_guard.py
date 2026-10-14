"""Veto clearly contradictory initial conclusions, without pretending to grade prose.

This deliberately narrow recognizer is not an adversarial-language classifier.
It reads explicit declarations, never the model's own extraction of a verdict.
Unknown, quoted, hypothetical or conflicting declarations are not regraded.
"""

import re
import unicodedata

from app.agents.llm import ProviderError
from app.models.schemas import TutorOutput

DECLARATION = re.compile(
    r"^\s*"
    r"(?:(?:但|不过|其实|最终|更正[:：]?)\s*)?"
    r"(?:我(?:认为|判断|觉得|的结论是|的答案是)|结论(?:是|为)?[:：]?|答案(?:是|为)?[:：]?)?\s*"
    r"(?:(?:该|这个|此|目标)?(?:出栈)?序列\s*)?"
    r"(?:是|为)?\s*"
    r"(?P<verdict>不合法|非法|不可能|不可以|不能|无法|合法|可以|可能|能够|能|impossible|possible|invalid|valid)"
    r"(?:得到(?:该|这个|目标)?(?:出栈)?序列)?"
    r"\s*(?:的(?:出栈序列|序列)?)?\s*"
    r"(?=$|[，,:：]|因为|由于|理由|过程|所以)",
    re.IGNORECASE,
)
NEGATIVE = {"不合法", "非法", "不可能", "不可以", "不能", "无法", "impossible", "invalid"}


def declared_verdict(answer: str) -> bool | None:
    """Read supported sentence-start conclusions; decline ambiguous/unsupported prose."""
    normalized = unicodedata.normalize("NFKC", answer)
    declarations: set[bool] = set()
    for sentence in re.finditer(r"([^。.!！?？;；\n]+)([。.!！?？;；\n]|$)", normalized):
        if sentence.group(2) in {"?", "？"}:
            continue
        match = DECLARATION.match(sentence.group(1))
        if match:
            declarations.add(match.group("verdict").lower() not in NEGATIVE)
    return next(iter(declarations)) if len(declarations) == 1 else None


def validate_initial_conclusion(result: TutorOutput, answer: str, possible: bool) -> None:
    verdict = declared_verdict(answer)
    if result.assessment == "correct" and verdict is not None and verdict != possible:
        # A solver proves the final conclusion wrong; it cannot diagnose WHY the student erred.
        # Reject the provider judgement instead of fabricating a misconception or tutor reply.
        raise ProviderError(502, "模型判断与题目参考校验冲突，请重试；本次作答尚未保存。")
