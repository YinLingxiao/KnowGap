"""Small local course library with Chinese/English lexical search and source snapshots."""
import io
import re
from pathlib import PurePosixPath

from fastapi import HTTPException
from pypdf import PdfReader

from app.memory.store import Store, ensure_column, new_id, now
from app.models.schemas import Material, SourceReference

MAX_UPLOAD_BYTES = 5 * 1024 * 1024
MAX_TEXT = 200_000
MAX_DOCUMENTS = 30
MAX_PAGES = 100
CHUNK_SIZE = 1000


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


def extract(filename: str, data: bytes) -> tuple[str, list[tuple[int | None, str]]]:
    kind = PurePosixPath(filename).suffix.lower().lstrip('.')
    if kind not in {'pdf', 'txt', 'md'}:
        raise HTTPException(415, '请上传 PDF、TXT 或 Markdown 文件。')
    if not data:
        raise HTTPException(422, '文件为空，请选择包含文字的资料。')
    if kind == 'pdf':
        if not data.lstrip().startswith(b'%PDF-'):
            raise HTTPException(422, '文件不是有效的 PDF。')
        try:
            reader = PdfReader(io.BytesIO(data), strict=False)
            if reader.is_encrypted:
                raise HTTPException(422, '暂不支持加密 PDF，请先解除密码。')
            if len(reader.pages) > MAX_PAGES:
                raise HTTPException(413, f'单份资料最多 {MAX_PAGES} 页，请按章节拆分。')
            pages, length = [], 0
            for number, page in enumerate(reader.pages, 1):
                text = (page.extract_text() or '').replace('\x00', '')
                length += len(text)
                if length > MAX_TEXT:
                    raise HTTPException(413, '资料文字过多，请按章节拆分。')
                pages.append((number, text))
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(422, 'PDF 无法解析，请确认文件完整并包含可复制的文字。') from None
    else:
        try:
            text = data.decode('utf-8-sig').replace('\x00', '')
        except UnicodeError:
            raise HTTPException(422, '文本资料需使用 UTF-8 编码。') from None
        if len(text) > MAX_TEXT:
            raise HTTPException(413, '资料文字过多，请按章节拆分。')
        pages = [(None, text)]
    if not any(text.strip() for _, text in pages):
        raise HTTPException(422, '没有提取到文字；扫描版 PDF 暂不支持，请上传文字版资料。')
    return kind, pages


class MaterialStore:
    def __init__(self, store: Store):
        self.store = store

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

    def add(self, student_id: str, filename: str, data: bytes, subject_id: str | None = None) -> Material:
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, '单份资料不能超过 5 MB。')
        title = PurePosixPath(filename.replace('\\', '/')).name
        title = ''.join(c for c in title if ord(c) >= 32 and ord(c) != 127)[:140] or '课程资料'
        kind, pages = extract(title, data)
        document_id = new_id('material')
        records = [(new_id('source'), document_id, text, page,
                    start if page is None else None, end if page is None else None)
                   for page, content in pages for text, start, end in chunks(content) if text.strip()]
        material = Material(id=document_id, title=title, kind=kind,
                            page_count=len(pages) if kind == 'pdf' else 0,
                            chunk_count=len(records), created_at=now(), subject_id=subject_id)
        with self.store.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            count = db.execute('SELECT COUNT(*) FROM course_materials WHERE student_id = ?', (student_id,)).fetchone()[0]
            if count >= MAX_DOCUMENTS:
                raise HTTPException(409, '最多保存 30 份资料，请删除不需要的资料后再上传。')
            db.execute('INSERT INTO course_materials(id, student_id, title, kind, page_count, chunk_count, created_at, '
                       'subject_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                       (document_id, student_id, title, kind, material.page_count, len(records), material.created_at,
                        subject_id))
            db.executemany('INSERT INTO course_chunks VALUES (?, ?, ?, ?, ?, ?)', records)
            db.executemany('INSERT INTO course_index(chunk_id, terms) VALUES (?, ?)',
                           [(record[0], ' '.join(terms(record[2]))) for record in records])
        return material

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
            return True

    def search_scoped(self, student_id: str, query: str, limit: int, subject_id: str | None) -> list[SourceReference]:
        """A Subject's own knowledge first, then unassigned materials; other Subjects' files are never mixed in."""
        found = self.search(student_id, query, limit, scope=subject_id) if subject_id else []
        if len(found) < limit:
            found += self.search(student_id, query, limit - len(found), scope=None)
        return [source.model_copy(update={'label': f'资料{index}'}) for index, source in enumerate(found, 1)]

    def search(self, student_id: str, query: str, limit: int = 5, scope: str | None | bool = True) -> list[SourceReference]:
        """scope: True = every material (legacy behaviour), None = unassigned only, str = that Subject only."""
        tokens = terms(query)
        # Retain only useful single-character terms; bigrams cover normal Chinese text.
        tokens = [t for t in tokens if len(t) > 1 or t in {'栈', '图', '树'}][:64]
        if not tokens:
            return []
        match = ' OR '.join('"' + token + '"' for token in tokens)
        with self.store.connection() as db:
            rows = db.execute('''
                SELECT c.*, d.title FROM course_index i
                JOIN course_chunks c ON c.id = i.chunk_id
                JOIN course_materials d ON d.id = c.document_id
                WHERE course_index MATCH ? AND d.student_id = ?
                AND (? = 1 OR (? IS NULL AND d.subject_id IS NULL) OR d.subject_id = ?)
                ORDER BY bm25(course_index), c.id LIMIT ?
            ''', (match, student_id, int(scope is True), None if scope is True else scope,
                  None if scope is True else scope, limit)).fetchall()
            return [SourceReference(id=row['id'], document_id=row['document_id'], title=row['title'],
                                    label=f'资料{index}', page=row['page'], start_line=row['start_line'],
                                    end_line=row['end_line'], excerpt=row['content'])
                    for index, row in enumerate(rows, 1)]
