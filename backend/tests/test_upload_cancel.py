"""取消上传：前端断开连接后，解析停掉，资料库里不留这份资料。"""
import asyncio

import pytest
from fastapi import HTTPException

from app.api.materials import unless_disconnected
from app.memory.store import Store
from app.services.materials import MAX_DOCUMENTS, MaterialStore, UploadCancelled, UploadGuard

STUDENT = "student"
TEXT = "栈遵循后进先出，只能访问栈顶。".encode("utf-8")


@pytest.fixture
def library(tmp_path):
    store = Store(tmp_path / "cancel.sqlite3")
    store.initialize()
    result = MaterialStore(store)
    result.initialize()
    return result


def never():
    async def check():
        return False
    return check


def after(calls: int):
    seen = {"n": 0}

    async def check():
        seen["n"] += 1
        return seen["n"] >= calls
    return check


def test_a_finished_upload_is_returned(library):
    guard = UploadGuard(student_id=STUDENT)
    material = asyncio.run(unless_disconnected(
        library, guard, library.add_with_ocr(STUDENT, "栈.md", TEXT, None, guard), never(), poll=0.01))
    assert material.title == "栈.md"
    assert [item.id for item in library.list_materials(STUDENT)] == [material.id]


def test_disconnecting_while_reading_cancels_and_stores_nothing(library):
    started = asyncio.Event()

    async def slow_reader(kind, data, reading):
        started.set()
        await asyncio.sleep(30)  # 识图很慢：取消必须打断它，而不是等它读完
        return reading

    library.slide_ocr = slow_reader
    guard = UploadGuard(student_id=STUDENT)

    async def scenario():
        with pytest.raises(HTTPException) as cancelled:
            await asyncio.wait_for(unless_disconnected(
                library, guard, library.add_with_ocr(STUDENT, "课件.docx", docx_bytes(), None, guard),
                after(3), poll=0.01), timeout=5)
        assert started.is_set()
        return cancelled.value

    assert asyncio.run(scenario()).status_code == 499
    assert guard.cancelled.is_set()
    assert library.list_materials(STUDENT) == []


def test_a_cancelled_guard_blocks_the_write(library):
    guard = UploadGuard(student_id=STUDENT)
    guard.cancelled.set()
    with pytest.raises(UploadCancelled):
        library.add(STUDENT, "栈.md", TEXT, guard=guard)
    assert library.list_materials(STUDENT) == []


def test_a_material_written_just_before_the_disconnect_is_removed(library):
    guard = UploadGuard(student_id=STUDENT)

    async def written_then_slow():
        material = library.add(STUDENT, "栈.md", TEXT, guard=guard)
        await asyncio.sleep(30)
        return material

    with pytest.raises(HTTPException):
        asyncio.run(unless_disconnected(library, guard, written_then_slow(), after(2), poll=0.01))
    assert guard.inserted
    assert library.list_materials(STUDENT) == []


def test_the_library_holds_more_than_a_handful_of_files(library):
    assert MAX_DOCUMENTS >= 200
    for index in range(40):
        library.add(STUDENT, f"第{index}讲.md", TEXT)
    assert len(library.list_materials(STUDENT)) == 40


def docx_bytes() -> bytes:
    import io

    from docx import Document

    document = Document()
    document.add_paragraph("栈遵循后进先出。")
    output = io.BytesIO()
    document.save(output)
    return output.getvalue()
