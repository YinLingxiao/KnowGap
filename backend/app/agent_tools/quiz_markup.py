"""网页里的在线选择题（单选 / 多选表单）还原成普通文字。

题库网站常把选项放在 <form><label><input type=radio>…</label></form> 里，答案放在容器的 data-answer 上。
正文提取器会把 <form> 当成页面模板丢掉，题干后面直接跳到解析，抽题时就缺选项和答案。
"""

import re

_CHOICE_INPUT = re.compile(r"^(radio|checkbox)$", re.I)
_LABELLED = re.compile(r"^[A-Fa-f][.．、)）:：]")
_ANSWER = re.compile(r"[A-Fa-f](?:[\s,，、]*[A-Fa-f])*")


def _declared_answer(form) -> str:
    """答案只认包住这道题的那一层容器上的 data-answer，且必须是选项字母。"""
    value = str((form.parent.attrs if form.parent is not None else {}).get("data-answer") or "").strip()
    return re.sub(r"[^A-F]", "", value.upper()) if _ANSWER.fullmatch(value) else ""


def restore_quiz_widgets(soup) -> int:
    """把选择题表单替换成「A. …」逐行文字，并在页面声明了答案时补一行「答案：C」。返回还原的题数。"""
    restored = 0
    for form in soup.find_all("form"):
        labels = [label for label in form.find_all("label")
                  if label.find("input", attrs={"type": _CHOICE_INPUT})]
        lines = [" ".join(label.get_text(" ", strip=True).split()) for label in labels]
        lines = [line for line in lines if line]
        if len(lines) < 2:
            continue
        if not any(_LABELLED.match(line) for line in lines):
            lines = [f"{chr(65 + index)}. {line}" for index, line in enumerate(lines)]
        answer = _declared_answer(form)
        if answer:
            lines.append(f"答案：{answer}")
        container = soup.new_tag("div")
        for line in lines:
            paragraph = soup.new_tag("p")
            paragraph.string = line
            container.append(paragraph)
        form.replace_with(container)
        restored += 1
    return restored
