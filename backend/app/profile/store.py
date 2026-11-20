import re
import sqlite3
from pathlib import Path

from app.memory.curated import ensure as ensure_curated
from app.memory.curated import join_entries, read_all, split_entries, write as write_note
from app.memory.store import Store, new_id, now
from app.models.schemas import DEMO_STUDENT

DEFAULT_DISPLAY_NAME = "学习者"
MAX_AVATAR_BYTES = 2 * 1024 * 1024
_NAME_ENTRY_RE = re.compile(r"^(?:\[Identity\]\s*)?称呼[：:]")
_MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}


def _sniff_avatar(data: bytes) -> tuple[str, str] | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png", "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg", "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return ".gif", "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp", "image/webp"
    return None


def _avatar_text(name: str) -> str:
    cleaned = (name or "").strip()
    return cleaned[:1] if cleaned else "学"


class ProfileStore:
    def __init__(self, store: Store):
        self.store = store
        self._cached_student_id: str | None = None

    @property
    def avatars_dir(self) -> Path:
        return self.store.path.parent / "avatars"

    def ensure(self) -> None:
        with self.store.connection() as db:
            ensure_curated(db)
            db.execute("""
                CREATE TABLE IF NOT EXISTS local_profile (
                    id INTEGER PRIMARY KEY CHECK(id = 1),
                    student_id TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    avatar_text TEXT NOT NULL DEFAULT '',
                    avatar_file TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            """)
            row = db.execute("SELECT student_id FROM local_profile WHERE id = 1").fetchone()
            if row is not None:
                self._cached_student_id = row["student_id"]
                return
            student_id, display_name, avatar_text = self._detect_initial_identity(db)
            stamp = now()
            db.execute(
                """INSERT INTO local_profile(id, student_id, display_name, avatar_text, avatar_file, created_at, updated_at)
                   VALUES (1, ?, ?, ?, '', ?, ?)""",
                (student_id, display_name, avatar_text, stamp, stamp),
            )
            self._cached_student_id = student_id

    @staticmethod
    def _has_student_data(db: sqlite3.Connection, student_id: str) -> bool:
        tables = {row["name"] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        for table in ("conversations", "subjects", "learner_memories", "agent_memory"):
            if table in tables and db.execute(f"SELECT 1 FROM {table} WHERE student_id = ? LIMIT 1", (student_id,)).fetchone():
                return True
        return False

    def _detect_initial_identity(self, db: sqlite3.Connection) -> tuple[str, str, str]:
        if not self._has_student_data(db, DEMO_STUDENT):
            has_users = db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").fetchone()
            if has_users:
                for user in db.execute("SELECT id, display_name, avatar_text FROM users ORDER BY updated_at DESC").fetchall():
                    if self._has_student_data(db, user["id"]):
                        name = (user["display_name"] or DEFAULT_DISPLAY_NAME).strip() or DEFAULT_DISPLAY_NAME
                        return user["id"], name, (user["avatar_text"] or _avatar_text(name))[:2]
        return DEMO_STUDENT, DEFAULT_DISPLAY_NAME, _avatar_text(DEFAULT_DISPLAY_NAME)

    def student_id(self) -> str:
        if self._cached_student_id:
            return self._cached_student_id
        self.ensure()
        return self._cached_student_id or DEMO_STUDENT

    @staticmethod
    def _public(row: sqlite3.Row) -> dict:
        name = row["display_name"] or DEFAULT_DISPLAY_NAME
        avatar_file = row["avatar_file"] or ""
        return {
            "id": row["student_id"],
            "display_name": name,
            "avatar_text": row["avatar_text"] or _avatar_text(name),
            "avatar_url": f"/api/profile/avatar?v={avatar_file}" if avatar_file else "",
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def get(self) -> dict:
        self.ensure()
        with self.store.connection() as db:
            row = db.execute("SELECT * FROM local_profile WHERE id = 1").fetchone()
            # 称呼也可能在记忆里被改（一句话改记忆、初识对话）：以 USER 里的「称呼：」为准同步回档案
            noted = self._noted_name(db, row["student_id"])
            if noted and noted != row["display_name"]:
                db.execute(
                    "UPDATE local_profile SET display_name = ?, avatar_text = ?, updated_at = ? WHERE id = 1",
                    (noted, _avatar_text(noted), now()),
                )
                row = db.execute("SELECT * FROM local_profile WHERE id = 1").fetchone()
            return self._public(row)

    @staticmethod
    def _noted_name(db: sqlite3.Connection, student_id: str) -> str:
        for entry in split_entries(read_all(db, student_id)["user"]):
            if _NAME_ENTRY_RE.match(entry):
                name = " ".join(_NAME_ENTRY_RE.sub("", entry, count=1).split()).strip()
                return name if 0 < len(name) <= 30 else ""
        return ""

    def update_display_name(self, display_name: str, *, sync_user_note: bool = True) -> dict:
        name = " ".join((display_name or "").split()).strip()
        if not name or len(name) > 30:
            raise ValueError("称呼需要 1 到 30 个字。")
        self.ensure()
        stamp = now()
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM local_profile WHERE id = 1").fetchone()
            student_id = row["student_id"]
            if sync_user_note:
                notes = split_entries(read_all(db, student_id)["user"])
                kept = [entry for entry in notes if not _NAME_ENTRY_RE.match(entry)]
                write_note(db, student_id, "user", join_entries([f"[Identity] 称呼：{name}", *kept]), stamp)
            db.execute(
                "UPDATE local_profile SET display_name = ?, avatar_text = ?, updated_at = ? WHERE id = 1",
                (name, _avatar_text(name), stamp),
            )
            updated = db.execute("SELECT * FROM local_profile WHERE id = 1").fetchone()
            return self._public(updated)

    def save_avatar(self, data: bytes) -> dict:
        if not data:
            raise ValueError("请选择一张图片。")
        if len(data) > MAX_AVATAR_BYTES:
            raise ValueError("头像图片不能超过 2 MB。")
        detected = _sniff_avatar(data)
        if detected is None:
            raise ValueError("仅支持 PNG、JPEG、WebP 或 GIF 图片。")
        ext, _ = detected
        self.ensure()
        filename = f"{new_id('av')}{ext}"
        self.avatars_dir.mkdir(parents=True, exist_ok=True)
        (self.avatars_dir / filename).write_bytes(data)
        old_file = ""
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT avatar_file FROM local_profile WHERE id = 1").fetchone()
            old_file = row["avatar_file"] if row else ""
            db.execute("UPDATE local_profile SET avatar_file = ?, updated_at = ? WHERE id = 1", (filename, now()))
            updated = db.execute("SELECT * FROM local_profile WHERE id = 1").fetchone()
        self._remove_file(old_file)
        return self._public(updated)

    def read_avatar(self) -> tuple[bytes, str] | None:
        self.ensure()
        with self.store.connection() as db:
            row = db.execute("SELECT avatar_file FROM local_profile WHERE id = 1").fetchone()
            filename = row["avatar_file"] if row else ""
        if not filename or Path(filename).name != filename:
            return None
        path = self.avatars_dir / filename
        if not path.is_file():
            return None
        media_type = _MIME_BY_EXT.get(path.suffix.lower(), "application/octet-stream")
        return path.read_bytes(), media_type

    def delete_avatar(self) -> dict:
        self.ensure()
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT avatar_file FROM local_profile WHERE id = 1").fetchone()
            old_file = row["avatar_file"] if row else ""
            db.execute("UPDATE local_profile SET avatar_file = '', updated_at = ? WHERE id = 1", (now(),))
            updated = db.execute("SELECT * FROM local_profile WHERE id = 1").fetchone()
        self._remove_file(old_file)
        return self._public(updated)

    def _remove_file(self, filename: str) -> None:
        if not filename or Path(filename).name != filename:
            return
        try:
            (self.avatars_dir / filename).unlink(missing_ok=True)
        except OSError:
            pass
