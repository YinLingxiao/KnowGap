"""AI 生成的文件，以及学生上传文件的原件（供 edit_document 在原件上修改）。

元数据在 SQLite，文件本体放在数据库旁边的 files/ 目录，用 id 命名，文件名只存在元数据里，避免路径穿越。
"""

import re
from pathlib import Path

from app.memory.store import Store, new_id, now

MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_GENERATED_PER_STUDENT = 300
_ILLEGAL = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def safe_filename(name: str, extension: str) -> str:
    """去掉不能出现在 Windows 文件名里的字符，保证带上正确的扩展名。"""
    stem = _ILLEGAL.sub(" ", name).strip().strip(".")
    stem = re.sub(r"\.(docx?|pptx?|xlsx?|pdf|md|txt)$", "", stem, flags=re.I).strip()
    stem = re.sub(r"\s+", " ", stem)[:80] or "文档"
    return f"{stem}.{extension}"


class FileStore:
    def __init__(self, store: Store):
        self.store = store

    @property
    def directory(self) -> Path:
        return self.store.path.parent / "files"

    def initialize(self) -> None:
        with self.store.connection() as db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS stored_files (
                    id TEXT PRIMARY KEY, student_id TEXT NOT NULL, conversation_id TEXT,
                    name TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL,
                    origin TEXT NOT NULL CHECK(origin IN ('generated', 'upload')),
                    source_id TEXT, created_at TEXT NOT NULL
                )
            """)
            db.execute("CREATE INDEX IF NOT EXISTS stored_files_student ON stored_files(student_id, created_at)")

    def _path(self, file_id: str) -> Path:
        return self.directory / file_id

    def _insert(self, file_id: str, student_id: str, conversation_id: str | None, name: str, kind: str,
                data: bytes, origin: str, source_id: str | None) -> dict:
        if len(data) > MAX_FILE_BYTES:
            raise ValueError("文件超过 20 MB。")
        self.directory.mkdir(parents=True, exist_ok=True)
        self._path(file_id).write_bytes(data)
        record = {"id": file_id, "name": name, "kind": kind, "size": len(data), "origin": origin,
                  "source_id": source_id, "conversation_id": conversation_id, "created_at": now()}
        with self.store.connection() as db:
            db.execute(
                "INSERT OR REPLACE INTO stored_files(id, student_id, conversation_id, name, kind, size, origin, source_id, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (file_id, student_id, conversation_id, name, kind, len(data), origin, source_id, record["created_at"]),
            )
        return record

    def save_generated(self, student_id: str, conversation_id: str | None, name: str, kind: str, data: bytes,
                       source_id: str | None = None) -> dict:
        record = self._insert(new_id("file"), student_id, conversation_id, name, kind, data, "generated", source_id)
        self._trim(student_id)
        return record

    def save_original(self, material_id: str, student_id: str, name: str, kind: str, data: bytes) -> None:
        """上传的原件用资料 id 做文件 id，所以模型引用附件 id 就能找到它。"""
        self._insert(material_id, student_id, None, name, kind, data, "upload", None)

    def get(self, file_id: str, student_id: str) -> tuple[dict, bytes] | None:
        with self.store.connection() as db:
            row = db.execute("SELECT * FROM stored_files WHERE id = ? AND student_id = ?", (file_id, student_id)).fetchone()
        if row is None:
            return None
        try:
            data = self._path(file_id).read_bytes()
        except OSError:
            return None
        return dict(row), data

    def delete(self, file_id: str, student_id: str) -> None:
        with self.store.connection() as db:
            db.execute("DELETE FROM stored_files WHERE id = ? AND student_id = ?", (file_id, student_id))
        self._path(file_id).unlink(missing_ok=True)

    def _trim(self, student_id: str) -> None:
        with self.store.connection() as db:
            old = db.execute(
                "SELECT id FROM stored_files WHERE student_id = ? AND origin = 'generated' ORDER BY created_at DESC LIMIT -1 OFFSET ?",
                (student_id, MAX_GENERATED_PER_STUDENT),
            ).fetchall()
        for row in old:
            self.delete(row["id"], student_id)


def public(record: dict) -> dict:
    """给界面和 SSE 的字段，不含内部路径。"""
    return {key: record[key] for key in ("id", "name", "kind", "size")}
