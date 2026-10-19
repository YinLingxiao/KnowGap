import hashlib
import re
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, Request

from app.memory.store import Store
from app.models.schemas import DEMO_STUDENT

SESSION_DAYS = 30
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def utcnow() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 200_000)
    return f"pbkdf2_sha256${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    parts = (stored or "").split("$")
    if len(parts) != 3 or parts[0] != "pbkdf2_sha256":
        return False
    try:
        salt = bytes.fromhex(parts[1])
        expected = bytes.fromhex(parts[2])
    except ValueError:
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 200_000)
    return secrets.compare_digest(actual, expected)


class AuthStore:
    def __init__(self, store: Store):
        self.store = store

    def ensure(self) -> None:
        with self.store.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    display_name TEXT NOT NULL,
                    password_hash TEXT NOT NULL,
                    avatar_text TEXT NOT NULL DEFAULT '',
                    provider TEXT NOT NULL DEFAULT 'email',
                    provider_user_id TEXT NOT NULL DEFAULT '',
                    avatar_url TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS auth_sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS email_verification_codes (
                    email TEXT PRIMARY KEY COLLATE NOCASE,
                    code_hash TEXT NOT NULL,
                    purpose TEXT NOT NULL DEFAULT 'register',
                    attempts INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL
                );
            """)

    def student_from_request(self, request: Request) -> str:
        header = request.headers.get("authorization", "").strip()
        if not header:
            return DEMO_STUDENT
        user = self._user_for_header(header)
        if user is None:
            raise HTTPException(401, "登录已过期，请重新登录。")
        return user["id"]

    def require_user(self, request: Request) -> dict:
        header = request.headers.get("authorization", "").strip()
        if not header:
            raise HTTPException(401, "登录已过期，请重新登录。")
        user = self._user_for_header(header)
        if user is None:
            raise HTTPException(401, "登录已过期，请重新登录。")
        return user

    def _user_for_header(self, header: str) -> dict | None:
        if not header.lower().startswith("bearer "):
            return None
        raw = header[7:].strip()
        if not raw:
            return None
        return self.user_for_token(raw)

    def user_for_token(self, raw: str) -> dict | None:
        digest = hash_token(raw)
        now = utcnow()
        with self.store.connection() as db:
            row = db.execute(
                "SELECT user_id, expires_at FROM auth_sessions WHERE token_hash = ?", (digest,),
            ).fetchone()
            if row is None:
                return None
            if row["expires_at"] <= now:
                db.execute("DELETE FROM auth_sessions WHERE token_hash = ?", (digest,))
                return None
            user = db.execute("SELECT * FROM users WHERE id = ?", (row["user_id"],)).fetchone()
            return dict(user) if user else None

    def issue(self, user_id: str) -> str:
        raw = secrets.token_urlsafe(32)
        now = utcnow()
        expires = (datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)).replace(microsecond=0).isoformat()
        with self.store.connection() as db:
            db.execute(
                "INSERT INTO auth_sessions(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                (hash_token(raw), user_id, now, expires),
            )
        return raw

    def revoke(self, raw: str) -> None:
        with self.store.connection() as db:
            db.execute("DELETE FROM auth_sessions WHERE token_hash = ?", (hash_token(raw),))

    def update_display_name(self, user_id: str, display_name: str) -> dict:
        name = display_name.strip()
        if not name or len(name) > 30:
            raise HTTPException(422, "昵称需要 1 到 30 个字。")
        now = utcnow()
        with self.store.connection() as db:
            updated = db.execute(
                "UPDATE users SET display_name = ?, avatar_text = ?, updated_at = ? WHERE id = ?",
                (name, name[:1], now, user_id),
            ).rowcount
            if not updated:
                raise HTTPException(404, "账号不存在。")
            return dict(db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone())

    def register_local(self, email: str, password: str, display_name: str = "", code: str | None = None) -> dict:
        handle = (email or "").strip().lower()
        if len(handle) > 120 or not EMAIL_RE.match(handle):
            raise HTTPException(422, "请输入有效的邮箱地址。")
        if len(password or "") < 6 or len(password or "") > 128:
            raise HTTPException(422, "密码长度需为 6 到 128 个字符。")
        if code is not None:
            self.verify_email_code(handle, code)
        default_name = handle.split("@", 1)[0]
        name = _display(display_name, default_name)
        now = utcnow()
        user_id = "user-" + secrets.token_hex(8)
        pw_hash = hash_password(password)
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            exists = db.execute("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE", (handle,)).fetchone()
            if exists:
                raise HTTPException(409, "该邮箱已注册，请直接登录。")
            db.execute(
                """INSERT INTO users(id, username, display_name, password_hash, avatar_text, provider,
                   provider_user_id, avatar_url, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, 'email', ?, '', ?, ?)""",
                (user_id, handle, name, pw_hash, name[:1], user_id, now, now),
            )
            row = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            return dict(row)

    def create_email_code(self, email: str, purpose: str = "register") -> str:
        handle = (email or "").strip().lower()
        if len(handle) > 120 or not EMAIL_RE.match(handle):
            raise HTTPException(422, "请输入有效的邮箱地址。")
        if purpose not in {"register", "login"}:
            raise HTTPException(422, "验证码用途无效。")
        now_dt = datetime.now(timezone.utc)
        now = now_dt.replace(microsecond=0).isoformat()
        expires = (now_dt + timedelta(minutes=5)).replace(microsecond=0).isoformat()
        code = f"{secrets.randbelow(900000) + 100000}"
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            exists = db.execute("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE", (handle,)).fetchone()
            if purpose == "register" and exists:
                raise HTTPException(409, "该邮箱已注册，请直接登录。")
            if purpose == "login" and not exists:
                raise HTTPException(404, "该邮箱尚未注册，请先注册账号。")
            db.execute(
                """INSERT INTO email_verification_codes(email, code_hash, purpose, attempts, created_at, expires_at)
                   VALUES (?, ?, ?, 0, ?, ?)
                   ON CONFLICT(email) DO UPDATE SET
                       code_hash = excluded.code_hash,
                       purpose = excluded.purpose,
                       attempts = 0,
                       created_at = excluded.created_at,
                       expires_at = excluded.expires_at""",
                (handle, hash_token(code), purpose, now, expires),
            )
        return code

    def verify_email_code(self, email: str, code: str) -> None:
        handle = (email or "").strip().lower()
        cleaned = (code or "").strip()
        if not cleaned or len(cleaned) != 6 or not cleaned.isdigit():
            raise HTTPException(422, "请输入 6 位数字邮箱验证码。")
        now = utcnow()
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT * FROM email_verification_codes WHERE email = ? COLLATE NOCASE", (handle,),
            ).fetchone()
            if row is None or row["expires_at"] <= now:
                db.execute("DELETE FROM email_verification_codes WHERE email = ? COLLATE NOCASE", (handle,))
                raise HTTPException(400, "验证码已过期或未发送，请重新获取。")
            if row["attempts"] >= 5:
                db.execute("DELETE FROM email_verification_codes WHERE email = ? COLLATE NOCASE", (handle,))
                raise HTTPException(400, "验证码错误次数过多，请重新获取。")
            if not secrets.compare_digest(hash_token(cleaned), row["code_hash"]):
                db.execute(
                    "UPDATE email_verification_codes SET attempts = attempts + 1 WHERE email = ? COLLATE NOCASE",
                    (handle,),
                )
                raise HTTPException(400, "邮箱验证码不正确。")
            db.execute("DELETE FROM email_verification_codes WHERE email = ? COLLATE NOCASE", (handle,))

    def login_with_code(self, email: str, code: str) -> dict:
        handle = (email or "").strip().lower()
        if not handle:
            raise HTTPException(422, "请输入邮箱地址。")
        self.verify_email_code(handle, code)
        with self.store.connection() as db:
            row = db.execute("SELECT * FROM users WHERE username = ? COLLATE NOCASE", (handle,)).fetchone()
            if row is None:
                raise HTTPException(404, "该邮箱尚未注册，请先注册账号。")
            return dict(row)

    def login_local(self, email: str, password: str) -> dict:
        handle = (email or "").strip().lower()
        if not handle or not password:
            raise HTTPException(422, "请输入邮箱和密码。")
        with self.store.connection() as db:
            row = db.execute("SELECT * FROM users WHERE username = ? COLLATE NOCASE", (handle,)).fetchone()
            if row is None or not verify_password(password, row["password_hash"]):
                raise HTTPException(401, "邮箱或密码不正确。")
            return dict(row)

    def change_password(self, user_id: str, current_password: str, new_password: str) -> dict:
        if len(new_password or "") < 6 or len(new_password or "") > 128:
            raise HTTPException(422, "新密码长度需为 6 到 128 个字符。")
        now = utcnow()
        with self.store.connection() as db:
            row = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            if row is None:
                raise HTTPException(404, "账号不存在。")
            if not verify_password(current_password or "", row["password_hash"]):
                raise HTTPException(401, "当前密码不正确。")
            db.execute(
                "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
                (hash_password(new_password), now, user_id),
            )
            return dict(db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone())


def public_user(user: dict) -> dict:
    return {
        "id": user["id"],
        "username": user["username"],
        "display_name": user["display_name"],
        "avatar_text": user["avatar_text"],
        "avatar_url": user.get("avatar_url") or "",
        "provider": "email",
        "created_at": user["created_at"],
    }


def _display(display_name: str, fallback: str) -> str:
    name = (display_name or fallback or "学习者").strip()
    return name[:30] or "学习者"
