"""Conversation uploads and owner-checked file markers for model-facing history."""

import re
from typing import Annotated

from fastapi import APIRouter, File, HTTPException, UploadFile
from starlette.concurrency import run_in_threadpool

from app.auth.deps import current_student
from app.chat.store import ChatStore
from app.services.materials import MAX_UPLOAD_BYTES, MaterialStore

FILE_MARKER = re.compile(r'\[\[file:([^|\]\r\n]+)\|([^\]\r\n]*)\]\]')
ATTACHMENT_LINE = re.compile(r'^（附件：.*）\s*$', re.M)


def attachment_router(store: ChatStore, library: MaterialStore) -> APIRouter:
    router = APIRouter(prefix='/api/conversations', tags=['对话附件'])

    @router.post('/{conversation_id}/attachments', status_code=201)
    async def upload_attachment(conversation_id: str, file: Annotated[UploadFile, File()]):
        try:
            student_id = current_student()
            conversation = await run_in_threadpool(store.conversation, conversation_id, student_id)
            if conversation is None:
                raise HTTPException(404, '对话不存在或已删除。')
            subject = await run_in_threadpool(store.conversation_subject, conversation_id)
            data = await file.read(MAX_UPLOAD_BYTES + 1)
            if len(data) > MAX_UPLOAD_BYTES:
                raise HTTPException(413, '单份资料不能超过 20 MB。')
            material = await run_in_threadpool(library.add, student_id, file.filename or '', data,
                                              subject.id if subject else None)
            return await run_in_threadpool(library.attachment, material.id, student_id)
        finally:
            await file.close()

    return router


def attachment_query(text: str) -> str:
    """Do not let a filename (e.g. 笔记.xlsx) choose the skill or pollute retrieval."""
    return ATTACHMENT_LINE.sub('', text).strip()


def prepare_attachment_history(history, library: MaterialStore | None, student_id: str):
    """Copy, never mutate stored messages. Only leading standalone markers attach files.

    The first occurrence is derived from all persisted turns, not the bounded model window,
    making retries deterministic and preventing excerpts from repeating after compression.
    All other markers are stripped too, so foreign ids and literal inline markers cannot leak.
    """
    seen, cache, result, attached = set(), {}, [], []
    latest_user = next((i for i in range(len(history) - 1, -1, -1) if history[i]['role'] == 'user'), -1)

    def lookup(document_id):
        if document_id not in cache:
            cache[document_id] = library.attachment(document_id, student_id, excerpt=True) if library else None
        return cache[document_id]

    for index, original in enumerate(history):
        row = dict(original)
        leading, count, this_turn = True, 0, set()
        lines = []
        for line in row['content'].splitlines(keepends=True):
            marker = FILE_MARKER.fullmatch(line.strip()) if leading and row['role'] == 'user' else None
            if marker:
                count += 1
                info = lookup(marker[1]) if count <= 5 else None
                if info:
                    lines.append(f"（附件：{info['name']}，{info['units']} {info['unit_label']}）\n")
                    if info['id'] not in this_turn:
                        if index == latest_user:
                            item = {key: info[key] for key in ('id', 'name', 'kind', 'units', 'unit_label', 'outline')}
                            if info['id'] not in seen:
                                item['excerpt'] = info['excerpt']
                            attached.append(item)
                        this_turn.add(info['id'])
                continue
            if line.strip():
                leading = False
            # Non-leading markers are not attachments. Do not expose their raw syntax either.
            lines.append(FILE_MARKER.sub('', line))
        if row['role'] == 'user' and row['status'] != 'failed':
            seen.update(this_turn)
        row['content'] = ''.join(lines)
        result.append(row)
    return result, attached


def readable_file_markers(text: str) -> str:
    """Last-resort rendering for transcripts/summaries with no library context."""
    return FILE_MARKER.sub(lambda m: f'（附件：{m[2]}）', text)
