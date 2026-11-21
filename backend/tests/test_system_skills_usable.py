"""系统技能能不能用：按技能里写的做法真的走一遍。

做文件：模拟模型先 load_skill，再严格按技能教的写法调用 create_document / edit_document，打开生成的文件核对结构。
读文件：按技能里对「读出来是什么样」的描述，构造真实文件交给读取器，核对每一条描述都成立。
"""
import io
import re

from docx import Document
from docx.shared import Inches
from fastapi.testclient import TestClient
from openpyxl import Workbook, load_workbook
from pptx import Presentation
from pypdf import PdfReader

from app.chat.skills import system_skills
from app.main import create_app
from app.services.materials import extract_document
from tests.test_acceptance_support import isolated_settings
from tests.test_chat import send
from tests.test_documents import DocumentModel


def run_chat(tmp_path, calls, request):
    """一轮对话：模型依次调用 calls 里的工具；返回 (客户端结果, 生成的文件字节列表, 工具输出)。"""
    model = DocumentModel(calls)
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        cid = client.post("/api/conversations", json={}).json()["id"]
        events = send(client, cid, request, f"req-{abs(hash(request)) % 10**8}")
        files = [data for name, data in events if name == "file"]
        blobs = [client.get(f"/api/files/{item['id']}/download").content for item in files]
    return files, blobs, model.tool_outputs


def follow_up(tmp_path, first_calls, then_calls):
    """先生成一个文件，再在同一对话里让模型按技能修改它（file_id 取自第一轮生成的文件）。"""
    model = DocumentModel(first_calls)
    with TestClient(create_app(isolated_settings(tmp_path), chat_model=model)) as client:
        cid = client.post("/api/conversations", json={}).json()["id"]
        made = [data for name, data in send(client, cid, "先做一份", "req-make") if name == "file"][0]
        model.pending = [(name, {**arguments, "file_id": made["id"]} if name in {"edit_document", "read_document"} else arguments)
                         for name, arguments in then_calls]
        edited = [data for name, data in send(client, cid, "按要求改一下", "req-edit") if name == "file"]
        blob = client.get(f"/api/files/{edited[0]['id']}/download").content if edited else None
    return made, edited, blob, model.tool_outputs


# ------------------------------------------------------------------ 做文件

def test_the_model_receives_the_whole_skill_before_making_a_file(tmp_path):
    files, _, outputs = run_chat(tmp_path, [
        ("load_skill", {"skill": "make_docx"}),
        ("create_document", {"kind": "docx", "filename": "笔记", "content": "# 笔记\n\n正文。"}),
    ], "做成 Word")
    assert outputs[0] == system_skills.by_id("make_docx")["content"]
    assert len(files) == 1 and files[0]["name"] == "笔记.docx"


def test_make_docx_markdown_becomes_real_word_structure(tmp_path):
    content = (
        "# 栈与队列复习笔记\n\n"
        "## 一、栈\n\n栈是**后进先出**的线性表。\n\n"
        "### 常用操作\n\n- push 入栈\n- pop 出栈\n\n"
        "## 二、对比\n\n| 结构 | 进出顺序 | 典型应用 |\n| --- | --- | --- |\n| 栈 | 后进先出 | 括号匹配 |\n| 队列 | 先进先出 | 排队 |\n\n"
        "```c\nint top = -1;\n```\n\n> 见课件第 12 页\n\n1. 自测：栈顶在哪？\n2. 自测：循环队列怎么判满？\n"
    )
    _, blobs, _ = run_chat(tmp_path, [
        ("load_skill", {"skill": "make_docx"}),
        ("create_document", {"kind": "docx", "filename": "栈与队列复习笔记", "content": content}),
    ], "整理成 Word 笔记")
    document = Document(io.BytesIO(blobs[0]))
    styles = [(p.style.name, p.text) for p in document.paragraphs if p.text.strip()]
    assert ("Title", "栈与队列复习笔记") in styles or ("Heading 1", "栈与队列复习笔记") in styles
    assert any(style.startswith("Heading") and text == "一、栈" for style, text in styles)
    assert any(style.startswith("Heading") and text == "常用操作" for style, text in styles)
    assert any("List" in style and text == "push 入栈" for style, text in styles)
    assert len(document.tables) == 1 and document.tables[0].cell(1, 0).text == "栈"
    assert any("int top = -1;" in text for _, text in styles)


def test_make_docx_edit_operations_work_as_the_skill_describes(tmp_path):
    made, edited, blob, outputs = follow_up(tmp_path, [
        ("create_document", {"kind": "docx", "filename": "报告", "content": "# 报告\n\n## 结论\n\n此处待补充。\n\n## 附录\n\n旧的附录。"}),
    ], [
        ("load_skill", {"skill": "make_docx"}),
        ("read_document", {"start": 1, "limit": 5}),
        ("edit_document", {"operations": [
            {"op": "replace", "find": "此处待补充。", "replace": "栈适合括号匹配。"},
            {"op": "insert_after", "after": "栈适合括号匹配。", "markdown": "队列适合排队调度。"},
            {"op": "delete", "find": "旧的附录。"},
            {"op": "append", "markdown": "## 参考\n\n- 课件第 12 页"},
        ]}),
    ])
    assert any("【第 1 页】" in output for output in outputs), "read_document returns page-tagged text"
    assert edited and edited[0]["name"] != made["name"], "saved as a new file; the original stays"
    text = "\n".join(p.text for p in Document(io.BytesIO(blob)).paragraphs)
    assert "栈适合括号匹配。" in text and text.index("栈适合括号匹配。") < text.index("队列适合排队调度。")
    assert "旧的附录。" not in text and "课件第 12 页" in text


def test_make_pptx_gives_a_cover_one_slide_per_heading_notes_and_a_table(tmp_path):
    content = (
        "# 栈与队列\n\n"
        "## 什么是栈\n\n- 后进先出\n- 只在栈顶操作\n- 例子：叠盘子\n\n备注：先用叠盘子引入，再讲定义。\n\n"
        "## 栈和队列对比\n\n| 结构 | 进出顺序 |\n| --- | --- |\n| 栈 | 后进先出 |\n| 队列 | 先进先出 |\n\n"
        "## 总结\n\n- 栈：LIFO\n- 队列：FIFO\n"
    )
    _, blobs, _ = run_chat(tmp_path, [
        ("load_skill", {"skill": "make_pptx"}),
        ("create_document", {"kind": "pptx", "filename": "栈与队列", "content": content, "subtitle": "数据结构 · 第 3 讲"}),
    ], "做个 PPT")
    slides = list(Presentation(io.BytesIO(blobs[0])).slides)
    texts = [" ".join(shape.text_frame.text for shape in slide.shapes if shape.has_text_frame) for slide in slides]
    assert len(slides) == 4, "cover + one slide per ## heading"
    assert "栈与队列" in texts[0] and "数据结构 · 第 3 讲" in texts[0]
    assert "什么是栈" in texts[1] and "后进先出" in texts[1]
    assert slides[1].has_notes_slide and "先用叠盘子引入" in slides[1].notes_slide.notes_text_frame.text
    assert "备注" not in texts[1], "notes go to the speaker notes, not onto the slide"
    assert any(shape.has_table for shape in slides[2].shapes)


def test_make_pptx_edit_operations_work_as_the_skill_describes(tmp_path):
    _, edited, blob, _ = follow_up(tmp_path, [
        ("create_document", {"kind": "pptx", "filename": "汇报", "content": "# 汇报\n\n## 背景\n\n- 旧要点\n\n## 删掉这页\n\n- 无用\n"}),
    ], [
        ("load_skill", {"skill": "make_pptx"}),
        ("edit_document", {"operations": [
            {"op": "replace", "find": "旧要点", "replace": "新要点"},
            {"op": "set_notes", "slide": 2, "text": "这一页讲背景。"},
            {"op": "delete_slide", "slide": 3},
            {"op": "append_slides", "markdown": "## 总结\n\n- 三条结论\n\n备注：最后提问。"},
        ]}),
    ])
    slides = list(Presentation(io.BytesIO(blob)).slides)
    texts = [" ".join(shape.text_frame.text for shape in slide.shapes if shape.has_text_frame) for slide in slides]
    assert edited and len(slides) == 3
    assert "新要点" in texts[1] and "旧要点" not in " ".join(texts)
    assert slides[1].notes_slide.notes_text_frame.text == "这一页讲背景。"
    assert "删掉这页" not in " ".join(texts) and "总结" in texts[2]
    assert "最后提问" in slides[2].notes_slide.notes_text_frame.text


def test_make_xlsx_keeps_sheets_numbers_and_formulas(tmp_path):
    content = (
        "## 成绩\n\n| 姓名 | 平时（分） | 期末（分） | 总评（分） |\n| --- | --- | --- | --- |\n"
        "| 张三 | 85 | 90 | =B2*0.4+C2*0.6 |\n| 李四 | 70 | 58 | =B3*0.4+C3*0.6 |\n"
        "| 平均 | =AVERAGE(B2:B3) | =AVERAGE(C2:C3) | =AVERAGE(D2:D3) |\n\n"
        "## 说明\n\n| 字段 | 含义 |\n| --- | --- |\n| 总评 | 平时 40% + 期末 60% |\n"
    )
    _, blobs, _ = run_chat(tmp_path, [
        ("load_skill", {"skill": "make_xlsx"}),
        ("create_document", {"kind": "xlsx", "filename": "成绩统计", "content": content}),
    ], "做成 Excel")
    book = load_workbook(io.BytesIO(blobs[0]))
    assert book.sheetnames == ["成绩", "说明"]
    sheet = book["成绩"]
    assert [cell.value for cell in sheet[1]] == ["姓名", "平时（分）", "期末（分）", "总评（分）"]
    assert isinstance(sheet["B2"].value, (int, float)) and sheet["B2"].value == 85
    assert sheet["D2"].value == "=B2*0.4+C2*0.6" and sheet["B4"].value == "=AVERAGE(B2:B3)"


def test_make_xlsx_edit_operations_work_as_the_skill_describes(tmp_path):
    _, edited, blob, _ = follow_up(tmp_path, [
        ("create_document", {"kind": "xlsx", "filename": "打卡", "content": "## 打卡\n\n| 日期 | 用时（分钟） |\n| --- | --- |\n| 2026-11-20 | 30 |\n"}),
    ], [
        ("load_skill", {"skill": "make_xlsx"}),
        ("edit_document", {"operations": [
            {"op": "append_rows", "sheet": "打卡", "rows": [["2026-11-21", 45], ["2026-11-22", 50]]},
            {"op": "set_cell", "sheet": "打卡", "cell": "B5", "value": "=SUM(B2:B4)"},
            {"op": "replace", "find": "用时（分钟）", "replace": "学习用时（分钟）"},
        ]}),
    ])
    sheet = load_workbook(io.BytesIO(blob))["打卡"]
    assert edited and sheet["A1"].value == "日期" and sheet["B1"].value == "学习用时（分钟）"
    assert sheet["B3"].value == 45 and sheet["B4"].value == 50 and sheet["B5"].value == "=SUM(B2:B4)"


def test_make_pdf_is_a_real_pdf_and_cannot_be_edited_in_place(tmp_path):
    made, edited, _, outputs = follow_up(tmp_path, [
        ("load_skill", {"skill": "make_pdf"}),
        ("create_document", {"kind": "pdf", "filename": "Checklist", "content": "# Checklist\n\n## Part 1\n\n- push\n- pop\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n"}),
    ], [
        ("edit_document", {"operations": [{"op": "replace", "find": "push", "replace": "enqueue"}]}),
    ])
    assert made["name"] == "Checklist.pdf" and made["kind"] == "pdf"
    assert not edited, "the skill says a PDF cannot be edited with edit_document"
    assert "create_document" in outputs[-1], "the tool error points to regenerating, as the skill says"


def test_generated_pdf_has_pages(tmp_path):
    _, blobs, _ = run_chat(tmp_path, [
        ("create_document", {"kind": "pdf", "filename": "Notes", "content": "# Notes\n\n" + "\n\n".join(f"## Section {i}\n\nLine {i}." for i in range(1, 4))}),
    ], "export pdf")
    assert blobs[0].startswith(b"%PDF") and len(PdfReader(io.BytesIO(blobs[0])).pages) >= 1


# ------------------------------------------------------------------ 读文件：技能里的描述要和读取器的真实输出一致

def pptx_bytes() -> bytes:
    presentation = Presentation()
    first = presentation.slides.add_slide(presentation.slide_layouts[1])
    first.shapes.title.text = "第一讲 栈"
    first.placeholders[1].text = "后进先出"
    first.notes_slide.notes_text_frame.text = "先讲叠盘子的例子"
    hidden = presentation.slides.add_slide(presentation.slide_layouts[5])
    hidden.shapes.title.text = "备用页"
    hidden._element.set("show", "0")
    table_slide = presentation.slides.add_slide(presentation.slide_layouts[5])
    table_slide.shapes.title.text = "对比"
    table = table_slide.shapes.add_table(2, 2, Inches(1), Inches(2), Inches(4), Inches(1)).table
    table.cell(0, 0).text, table.cell(0, 1).text, table.cell(1, 0).text, table.cell(1, 1).text = "结构", "顺序", "栈", "LIFO"
    output = io.BytesIO()
    presentation.save(output)
    return output.getvalue()


def test_read_pptx_claims_hold():
    content = system_skills.by_id("read_pptx")["content"]
    _, reading = extract_document("课件.pptx", pptx_bytes())
    pages = dict(reading.pages)
    assert "「备注：」开头的是演讲者备注" in content and "备注：先讲叠盘子的例子" in pages[1]
    assert "（这张幻灯片在放映时是隐藏的）" in content and "（这张幻灯片在放映时是隐藏的）" in pages[2]
    assert "表格（Markdown）" in content and re.search(r"\| *结构 *\| *顺序 *\|", pages[3])
    assert len(pages) == 3, "one page per slide"


def test_read_xlsx_claims_hold():
    content = system_skills.by_id("read_xlsx")["content"]
    book = Workbook()
    sheet = book.active
    sheet.title = "成绩"
    sheet.append(["姓名", "成绩"])
    sheet.append(["张三", 90])
    sheet.append(["合计", "=SUM(B2:B2)"])
    book.create_sheet("备份").sheet_state = "hidden"
    big = book.create_sheet("流水")
    for index in range(260):
        big.append([index, index * 2])
    output = io.BytesIO()
    book.save(output)
    _, reading = extract_document("成绩.xlsx", output.getvalue())
    pages = dict(reading.pages)
    assert "以 # 工作表名 开头" in content and pages[1].startswith("# 成绩")
    assert "公式本身" in content and "=SUM(B2:B2)" in pages[1]
    assert "（隐藏的工作表，没有读取）" in content and "（隐藏的工作表，没有读取）" in pages[2]
    assert "只读前 200 行" in content and any("200" in note for note in reading.notes)
    assert "| 张三 | 90 |" in pages[1].replace("  ", " ")


def test_read_csv_handles_excel_gbk_as_the_skill_says():
    assert "GBK 都能识别" in system_skills.by_id("read_xlsx")["content"]
    _, reading = extract_document("成绩.csv", "姓名,成绩\n张三,90\n".encode("gbk"))
    assert "张三,90" in reading.pages[0][1]


def test_read_docx_claims_hold():
    content = system_skills.by_id("read_docx")["content"]
    document = Document()
    document.sections[0].header.paragraphs[0].text = "数据结构讲义"
    document.add_heading("第一章 栈", 1)
    document.add_paragraph("入栈", style="List Bullet")
    table = document.add_table(rows=2, cols=2)
    table.cell(0, 0).text, table.cell(0, 1).text, table.cell(1, 0).text, table.cell(1, 1).text = "操作", "复杂度", "push", "O(1)"
    for index in range(4):
        document.add_paragraph(f"第 {index} 段：" + "栈是一种线性表。" * 60)
    output = io.BytesIO()
    document.save(output)
    _, reading = extract_document("讲义.docx", output.getvalue())
    pages = dict(reading.pages)
    assert "约 1500 字切成若干「节」" in content and len(pages) >= 2 and all(len(text) <= 1500 for text in pages.values())
    assert "标题会变成 Markdown 标题" in content and "# 第一章 栈" in pages[1]
    assert "列表项以 - 开头" in content and "- 入栈" in pages[1]
    assert "表格是 Markdown 表格" in content and re.search(r"\| *操作 *\| *复杂度 *\|", pages[1])
    assert "【页眉页脚】" in content and "【页眉页脚】数据结构讲义" in pages[max(pages)]


def test_reading_skills_mention_the_tools_with_the_real_limits():
    for skill_id in ("read_pdf", "read_pptx"):
        assert "最多 20" in system_skills.by_id(skill_id)["content"]
    from app.agent_tools.documents import DEFINITIONS
    read = next(tool for tool in DEFINITIONS if tool["function"]["name"] == "read_document")
    assert "最大 20" in read["function"]["parameters"]["properties"]["limit"]["description"]
