"""Small local course library with Chinese/English lexical search and source snapshots."""
import io
import json
import re
from pathlib import PurePosixPath
from typing import Literal

from fastapi import HTTPException
from pypdf import PdfReader

from app.agents.llm import ProviderError
from app.memory.store import Store, ensure_column, new_id, now
from app.models.schemas import Material as BaseMaterial, SourceReference
from app.services.office_readers import (
    Reading, read_doc, read_docx, read_ppt, read_pptx, read_xls, read_xlsx,
)

MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_TEXT = 200_000
MAX_DOCUMENTS = 30
MAX_PAGES = 200
CHUNK_SIZE = 1000
UNIT_LABELS = {'pdf': '页', 'docx': '节', 'pptx': '张幻灯片', 'xlsx': '个工作表', 'text': '页'}
# 旧版二进制格式存成对应的新格式类型（界面、技能、检索都按新格式处理），文件名保留原样
LEGACY_KINDS = {'doc': 'docx', 'ppt': 'pptx', 'xls': 'xlsx'}
SUPPORTED = {'pdf', 'txt', 'md', 'csv', 'docx', 'pptx', 'xlsx', *LEGACY_KINDS}
SUPPORTED_HINT = 'PDF、Word（.docx / .doc）、PowerPoint（.pptx / .ppt）、Excel（.xlsx / .xls）、TXT、Markdown 或 CSV'


class ScannedPdfError(HTTPException):
    """PDF 没有文字层（扫描图片）。上传入口可以改走识图模型转写。"""


class Material(BaseMaterial):
    """Extended library wire model; preserve the existing fields and legacy text kinds."""
    kind: Literal['pdf', 'txt', 'md', 'csv', 'docx', 'pptx', 'xlsx']
    # 原始文件字节数：前端预览面板用它在拉取整份文件前决定要不要降级成「下载查看」
    size_bytes: int = 0


def outline_for(pages: list[tuple[int | None, str]]) -> list[str]:
    headings = [m.group(1).strip() for _, text in pages
                for m in re.finditer(r'^#{1,6}\s+(.+)$', text, re.M)]
    if not headings:
        headings = [text.strip().splitlines()[0] for _, text in pages if text.strip()]
    # 课件常有几十张幻灯片：大纲要能列到每一张的标题，模型才知道后面讲了什么
    return list(dict.fromkeys(h[:200] for h in headings))[:80]


def terms(text: str) -> list[str]:
    tokens = []
    for word in re.findall(r"[a-zA-Z][a-zA-Z0-9_]*|[\u3400-\u9fff]+", text.lower()):
        if '\u3400' <= word[0] <= '\u9fff':
            tokens.extend(word)
            tokens.extend(word[i:i + 2] for i in range(len(word) - 1))
        else:
            tokens.append(word)
    return list(dict.fromkeys(tokens))


def chunks(text: str):
    """Keep original line boundaries so TXT/Markdown citations are reproducible."""
    buffer, start, end = '', 1, 1
    for number, line in enumerate(text.splitlines(), 1):
        for offset in range(0, max(len(line), 1), CHUNK_SIZE):
            part = line[offset:offset + CHUNK_SIZE]
            if buffer and len(buffer) + len(part) + 1 > CHUNK_SIZE:
                yield buffer, start, end
                buffer = ''
            if not buffer:
                start = number
            buffer += ('\n' if buffer else '') + part
            end = number
    if buffer.strip():
        yield buffer, start, end


def _decode_text(data: bytes) -> str:
    """文本资料的编码：UTF-8（带或不带 BOM）、带 BOM 的 UTF-16，再退回 GB18030（国内导出的 CSV 常是 GBK）。"""
    if data[:2] in (b'\xff\xfe', b'\xfe\xff'):
        try:
            return data.decode('utf-16')
        except UnicodeError:
            pass
    try:
        return data.decode('utf-8-sig')
    except UnicodeError:
        pass
    try:
        return data.decode('gb18030')
    except UnicodeError:
        raise HTTPException(422, '无法识别文本编码，请另存为 UTF-8 后上传。') from None


def _read_pdf(data: bytes) -> Reading:
    if not data.lstrip().startswith(b'%PDF-'):
        raise HTTPException(422, '文件不是有效的 PDF。')
    try:
        reader = PdfReader(io.BytesIO(data), strict=False)
        if reader.is_encrypted:
            try:
                unlocked = reader.decrypt('')  # 很多 PDF 只是限制编辑，没有打开密码
            except Exception:  # noqa: BLE001
                unlocked = 0
            if not unlocked:
                raise HTTPException(422, '这份 PDF 需要密码才能打开，请先解除密码。')
        if len(reader.pages) > MAX_PAGES:
            raise HTTPException(413, f'单份资料最多 {MAX_PAGES} 页，请按章节拆分。')
        pages, empty, length = [], [], 0
        for number, page in enumerate(reader.pages, 1):
            text = (page.extract_text() or '').replace('\x00', '')
            if not text.strip():
                empty.append(number)
            length += len(text)
            if length > MAX_TEXT:
                raise HTTPException(413, '资料文字过多，请按章节拆分。')
            pages.append((number, text))
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(422, 'PDF 无法解析，请确认文件完整并包含可复制的文字。') from None
    notes = []
    if empty and len(empty) < len(pages):
        shown = '、'.join(str(n) for n in empty[:12])
        notes.append(f'第 {shown}{" 等" if len(empty) > 12 else ""} 页没有可读的文字（可能是扫描图片或纯图片页），这些页的内容没有读取。')
    return Reading(pages, notes)


_OFFICE_READERS = {'docx': read_docx, 'pptx': read_pptx, 'xlsx': read_xlsx,
                   'doc': read_doc, 'ppt': read_ppt, 'xls': read_xls}
_LEGACY_HINT = {'doc': 'Word', 'ppt': 'PowerPoint', 'xls': 'Excel'}


def extract_document(filename: str, data: bytes, *, allow_empty: bool = False) -> tuple[str, Reading]:
    """读取一份资料，返回 (类型, Reading)。旧版 doc / ppt / xls 的类型记作 docx / pptx / xlsx。"""
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, '单份资料不能超过 20 MB。')
    ext = PurePosixPath(filename).suffix.lower().lstrip('.')
    if ext not in SUPPORTED:
        raise HTTPException(415, f'请上传 {SUPPORTED_HINT} 文件。')
    if not data:
        raise HTTPException(422, '文件为空，请选择包含文字的资料。')
    if ext == 'pdf':
        reading = _read_pdf(data)
    elif ext in _OFFICE_READERS:
        # 扩展名和内容对不上（有人直接改了后缀）时，按内容读：OLE 复合文档是旧格式，ZIP 是新格式
        if data.startswith(b'\xd0\xcf\x11\xe0'):
            ext = {'docx': 'doc', 'pptx': 'ppt', 'xlsx': 'xls'}.get(ext, ext)
        elif data.startswith(b'PK'):
            ext = {'doc': 'docx', 'ppt': 'pptx', 'xls': 'xlsx'}.get(ext, ext)
        legacy = ext in LEGACY_KINDS
        if not data.startswith((b'\xd0\xcf\x11\xe0', b'PK')):
            raise HTTPException(422, '文件无法解析：内容不是有效的 Office 文件，请确认文件完整，或另存为新格式后上传。')
        try:
            reading = _OFFICE_READERS[ext](data)
        except HTTPException:
            raise
        except Exception:
            if legacy:
                raise HTTPException(422, f'这份旧版文件没能解析（可能已损坏、加密或版本过旧）。请在 {_LEGACY_HINT[ext]} 或 WPS 里另存为新格式后上传。') from None
            raise HTTPException(422, '文件无法解析，请确认文件完整、未加密且格式正确。') from None
    else:
        text = _decode_text(data)
        text = text.replace('\x00', '')
        if len(text) > MAX_TEXT:
            raise HTTPException(413, '资料文字过多，请按章节拆分。')
        reading = Reading([(None, text)], [])
    if len(reading.pages) > MAX_PAGES:
        raise HTTPException(413, f'单份资料最多 {MAX_PAGES} 页/节/幻灯片/工作表，请按章节拆分。')
    if sum(len(text) for _, text in reading.pages) > MAX_TEXT:
        raise HTTPException(413, '资料文字过多，请按章节拆分。')
    if not allow_empty and not any(text.strip() for _, text in reading.pages):
        if ext == 'pdf':
            raise ScannedPdfError(422, '这份 PDF 是扫描图片，暂不支持识别文字')
        raise HTTPException(422, '没有提取到文字，请选择包含文字的资料。')
    return LEGACY_KINDS.get(ext, ext), reading


def extract(filename: str, data: bytes) -> tuple[str, list[tuple[int | None, str]]]:
    kind, reading = extract_document(filename, data)
    return kind, reading.pages


class MaterialStore:
    def __init__(self, store: Store):
        self.store = store
        # FileStore：保存上传原件，让 AI 能在原件上修改（edit_document）。由 main.py 挂上
        self.originals = None
        # async (pdf 字节) -> Reading：扫描版 PDF 转写，由 main.py 挂上；没有时扫描件直接报错
        self.ocr = None
        # async (kind, 原件字节, Reading) -> Reading：把课件里的图片交给识图模型，文字并回对应幻灯片
        self.slide_ocr = None

    def initialize(self):
        with self.store.connection() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS course_materials (
                    id TEXT PRIMARY KEY, student_id TEXT NOT NULL, title TEXT NOT NULL,
                    kind TEXT NOT NULL, page_count INTEGER NOT NULL, chunk_count INTEGER NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS course_chunks (
                    id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES course_materials(id) ON DELETE CASCADE,
                    content TEXT NOT NULL, page INTEGER, start_line INTEGER, end_line INTEGER
                );
                CREATE VIRTUAL TABLE IF NOT EXISTS course_index USING fts5(chunk_id UNINDEXED, terms);
            ''')
            # NULL = not filed under a Subject ("未归类").
            ensure_column(db, 'course_materials', 'subject_id', 'TEXT')
            ensure_column(db, 'course_materials', 'outline_json', "TEXT NOT NULL DEFAULT '[]'")
            ensure_column(db, 'course_materials', 'chars', 'INTEGER NOT NULL DEFAULT 0')
            # 读取说明：哪些内容没读到（图片里的字、隐藏页、扫描页……），交给模型如实告诉学生
            ensure_column(db, 'course_materials', 'notes_json', "TEXT NOT NULL DEFAULT '[]'")
            # 识图模型读出的文字（页码 → 文字）：原件里没有，read_document 重新解析原件时用它补回
            ensure_column(db, 'course_materials', 'ocr_json', "TEXT NOT NULL DEFAULT '{}'")
            # 原始文件字节数：预览面板用它判断要不要降级，历史记录没有这列时统一按 0（会直接尝试渲染，不影响正确性）
            ensure_column(db, 'course_materials', 'size_bytes', 'INTEGER NOT NULL DEFAULT 0')

    async def add_with_ocr(self, student_id: str, filename: str, data: bytes, subject_id: str | None = None) -> Material:
        """上传入口用这个：扫描版 PDF 先尝试让识图模型转写，其余和 add 一样。"""
        from starlette.concurrency import run_in_threadpool

        extension = PurePosixPath(filename).suffix.lower()
        if self.slide_ocr is not None and extension in ('.ppt', '.pptx'):
            return await self._add_slides(student_id, filename, data, subject_id)
        try:
            return await run_in_threadpool(self.add, student_id, filename, data, subject_id)
        except ScannedPdfError:
            if self.ocr is None:
                raise
            try:
                reading = await self.ocr(data)
            except ProviderError as exc:
                raise HTTPException(422 if exc.status_code == 503 else 502, exc.detail) from None
            return await run_in_threadpool(self.add, student_id, filename, data, subject_id, ('pdf', reading))

    async def _add_slides(self, student_id: str, filename: str, data: bytes, subject_id: str | None) -> Material:
        """课件：先读文字，再让识图模型读幻灯片里的图片；图片读不了不影响文字。"""
        from starlette.concurrency import run_in_threadpool

        kind, reading = await run_in_threadpool(extract_document, filename, data, allow_empty=True)
        try:
            reading = await self.slide_ocr(kind, data, reading)
        except Exception:  # noqa: BLE001 - 图片只是增强，失败时保留已读到的文字
            pass
        if not any(text.strip() for _, text in reading.pages):
            raise HTTPException(422, '没有提取到文字，请选择包含文字的资料。')
        return await run_in_threadpool(self.add, student_id, filename, data, subject_id, (kind, reading))

    def add(self, student_id: str, filename: str, data: bytes, subject_id: str | None = None,
            preread: tuple[str, Reading] | None = None) -> Material:
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, '单份资料不能超过 20 MB。')
        title = PurePosixPath(filename.replace('\\', '/')).name
        title = ''.join(c for c in title if ord(c) >= 32 and ord(c) != 127)[:140] or '课程资料'
        kind, reading = preread if preread is not None else extract_document(title, data)
        pages = reading.pages
        document_id = new_id('material')
        records = [(new_id('source'), document_id, text, page,
                    start if page is None else None, end if page is None else None)
                   for page, content in pages for text, start, end in chunks(content) if text.strip()]
        material = Material(id=document_id, title=title, kind=kind,
                            page_count=len(pages) if kind in {'pdf', 'docx', 'pptx', 'xlsx'} else 0,
                            chunk_count=len(records), created_at=now(), subject_id=subject_id, size_bytes=len(data))
        with self.store.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            count = db.execute('SELECT COUNT(*) FROM course_materials WHERE student_id = ?', (student_id,)).fetchone()[0]
            if count >= MAX_DOCUMENTS:
                raise HTTPException(409, '最多保存 30 份资料，请删除不需要的资料后再上传。')
            db.execute('INSERT INTO course_materials(id, student_id, title, kind, page_count, chunk_count, created_at, '
                       'subject_id, outline_json, chars, notes_json, ocr_json, size_bytes) '
                       'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                       (document_id, student_id, title, kind, material.page_count, len(records), material.created_at,
                        subject_id, json.dumps(outline_for(pages), ensure_ascii=False), sum(len(text) for _, text in pages),
                        json.dumps(reading.notes, ensure_ascii=False),
                        json.dumps({str(page): text for page, text in reading.extra.items()}, ensure_ascii=False),
                        len(data)))
            db.executemany('INSERT INTO course_chunks VALUES (?, ?, ?, ?, ?, ?)', records)
            db.executemany('INSERT INTO course_index(chunk_id, terms) VALUES (?, ?)',
                           [(record[0], ' '.join(terms(record[2]))) for record in records])
        if self.originals is not None:
            try:
                self.originals.save_original(document_id, student_id, title, kind, data)
            except Exception:
                pass  # 原件只用于修改；保存不了不影响读取和检索
        return material

    def recognized_text(self, document_id: str, student_id: str) -> tuple[dict[int, str], list[str]]:
        """上传时由识图模型读出的文字（页码 → 文字），和当时的读取说明。没有就返回空。"""
        with self.store.connection() as db:
            row = db.execute('SELECT ocr_json, notes_json FROM course_materials WHERE id = ? AND student_id = ?',
                             (document_id, student_id)).fetchone()
        if row is None:
            return {}, []
        try:
            return {int(page): text for page, text in json.loads(row['ocr_json'] or '{}').items()}, json.loads(row['notes_json'] or '[]')
        except (ValueError, TypeError):
            return {}, []

    def attachment(self, document_id: str, student_id: str, *, excerpt: bool = False,
                   excerpt_limit: int = 3000) -> dict | None:
        """Owner-scoped attachment metadata, including a bounded first-turn preview."""
        with self.store.connection() as db:
            row = db.execute('SELECT * FROM course_materials WHERE id = ? AND student_id = ?',
                             (document_id, student_id)).fetchone()
            if row is None:
                return None
            kind = row['kind'] if row['kind'] in UNIT_LABELS else 'text'
            result = dict(id=row['id'], name=row['title'], kind=kind, units=row['page_count'] or 1,
                          unit_label=UNIT_LABELS[kind], chars=row['chars'],
                          outline=json.loads(row['outline_json']), subject_id=row['subject_id'],
                          notes=json.loads(row['notes_json'] or '[]'))
            if excerpt:
                # rowid preserves original extraction order, including chunks on the same page.
                preview = ''
                for chunk in db.execute('SELECT content FROM course_chunks WHERE document_id = ? ORDER BY rowid',
                                        (document_id,)):
                    preview += ('\n' if preview else '') + chunk['content']
                    if len(preview) >= excerpt_limit:
                        break
                result['excerpt'] = preview[:excerpt_limit]
                # 让模型知道这是不是全文：不是全文时只能据可见部分作答，并提示学生按页追问
                result['excerpt_complete'] = len(preview) <= excerpt_limit and len(preview) >= (row['chars'] or 0) * 0.9
            return result

    def list_materials(self, student_id: str, subject_id: str | None = None, unassigned: bool = False) -> list[Material]:
        """All materials by default; one Subject's, or only unassigned ones, when asked."""
        with self.store.connection() as db:
            rows = db.execute('''
                SELECT * FROM course_materials WHERE student_id = ?
                AND (? = 0 OR subject_id IS NULL) AND (? IS NULL OR subject_id = ?) ORDER BY created_at DESC
            ''', (student_id, int(unassigned), subject_id, subject_id)).fetchall()
            return [Material(**dict(row)) for row in rows]

    def delete(self, document_id: str, student_id: str) -> bool:
        with self.store.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            if not db.execute('SELECT id FROM course_materials WHERE id = ? AND student_id = ?', (document_id, student_id)).fetchone():
                return False
            db.execute('DELETE FROM course_index WHERE chunk_id IN (SELECT id FROM course_chunks WHERE document_id = ?)', (document_id,))
            db.execute('DELETE FROM course_materials WHERE id = ?', (document_id,))
        if self.originals is not None:
            self.originals.delete(document_id, student_id)
        return True

    def search_scoped(self, student_id: str, query: str, limit: int, subject_id: str | None) -> list[SourceReference]:
        """A Subject's own knowledge first, then unassigned materials; other Subjects' files are never mixed in."""
        found = self.search(student_id, query, limit, scope=subject_id) if subject_id else []
        if len(found) < limit:
            found += self.search(student_id, query, limit - len(found), scope=None)
        return [source.model_copy(update={'label': f'资料{index}'}) for index, source in enumerate(found, 1)]

    def search(self, student_id: str, query: str, limit: int = 5, scope: str | None | bool = True,
               document_ids: list[str] | None = None) -> list[SourceReference]:
        """scope: True = every material (legacy behaviour), None = unassigned only, str = that Subject only."""
        tokens = terms(query)
        # Retain only useful single-character terms; bigrams cover normal Chinese text.
        tokens = [t for t in tokens if len(t) > 1 or t in {'栈', '图', '树'}][:64]
        if not tokens or document_ids == []:
            return []
        match = ' OR '.join('"' + token + '"' for token in tokens)
        with self.store.connection() as db:
            document_filter = (' AND d.id IN (' + ','.join('?' for _ in document_ids) + ')') if document_ids else ''
            rows = db.execute('''
                SELECT c.*, d.title FROM course_index i
                JOIN course_chunks c ON c.id = i.chunk_id
                JOIN course_materials d ON d.id = c.document_id
                WHERE course_index MATCH ? AND d.student_id = ?
                AND (? = 1 OR (? IS NULL AND d.subject_id IS NULL) OR d.subject_id = ?)
            ''' + document_filter + ' ORDER BY bm25(course_index), c.id LIMIT ?',
                (match, student_id, int(scope is True), None if scope is True else scope,
                 None if scope is True else scope, *(document_ids or []), limit)).fetchall()
            return [SourceReference(id=row['id'], document_id=row['document_id'], title=row['title'],
                                    label=f'资料{index}', page=row['page'], start_line=row['start_line'],
                                    end_line=row['end_line'], excerpt=row['content'])
                    for index, row in enumerate(rows, 1)]
