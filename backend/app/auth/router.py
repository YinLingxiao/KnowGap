import logging
import smtplib
from email.message import EmailMessage

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from app.auth.store import AuthStore, public_user
from app.chat.store import ChatStore
from app.config import Settings

logger = logging.getLogger(__name__)
CODE_TTL_SECONDS = 300


class PatchMe(BaseModel):
    display_name: str | None = None
    current_password: str | None = None
    new_password: str | None = None


class SendCodeBody(BaseModel):
    email: str
    purpose: str = "register"


class RegisterBody(BaseModel):
    email: str | None = None
    username: str | None = None
    password: str
    code: str | None = None
    display_name: str = ""


class LoginBody(BaseModel):
    email: str | None = None
    username: str | None = None
    password: str | None = None
    code: str | None = None


def _send_smtp_email(settings: Settings, recipient: str, code: str, purpose: str) -> None:
    msg = EmailMessage()
    action_label = "注册账号" if purpose == "register" else "登录验证"
    sender = (settings.smtp_from or settings.smtp_user).strip()
    msg["Subject"] = f"【知隙 KnowGap】你的{action_label}验证码：{code}"
    msg["From"] = sender
    msg["To"] = recipient
    msg.set_content(
        f"你好！\n\n你正在进行知隙（KnowGap）{action_label}。\n"
        f"你的 6 位验证码是：{code}\n\n"
        f"该验证码在 5 分钟内有效，请勿泄露给他人。\n"
    )
    host = settings.smtp_host.strip()
    port = settings.smtp_port
    password = settings.smtp_password.get_secret_value()
    server = smtplib.SMTP_SSL(host, port, timeout=15) if port == 465 else smtplib.SMTP(host, port, timeout=15)
    try:
        if port != 465:
            server.starttls()
        server.login(settings.smtp_user.strip(), password)
        server.send_message(msg)
    finally:
        try:
            server.quit()
        except Exception:
            pass


def auth_router(auth: AuthStore, chat: ChatStore, settings: Settings | None = None) -> APIRouter:
    router = APIRouter(prefix="/api/auth", tags=["邮箱登录"])

    @router.post("/send-code")
    async def send_code(body: SendCodeBody):
        code = auth.create_email_code(body.email, body.purpose)
        smtp_ready = BooleanSmtp(settings)
        if smtp_ready and settings is not None:
            try:
                await run_in_threadpool(_send_smtp_email, settings, body.email.strip(), code, body.purpose)
            except Exception as exc:
                # A rejected recipient (e.g. a test domain) or an unreachable server must not
                # strand a valid code; fall back to the on-screen demo delivery.
                logger.warning("SMTP delivery failed, falling back to demo code: %s", type(exc).__name__)
            else:
                return {"sent": True, "delivery": "smtp", "expires_in": CODE_TTL_SECONDS}
        return {"sent": True, "delivery": "demo", "demo_code": code, "expires_in": CODE_TTL_SECONDS}

    @router.post("/register", status_code=201)
    def register(body: RegisterBody):
        account = (body.email or body.username or "").strip()
        user = auth.register_local(account, body.password, body.display_name, code=body.code)
        token = auth.issue(user["id"])
        return {
            "token": token,
            "user": public_user(user),
            "onboarding": chat.onboarding_status(user["id"]),
        }

    @router.post("/login")
    def login(body: LoginBody):
        account = (body.email or body.username or "").strip()
        if body.code and not body.password:
            user = auth.login_with_code(account, body.code)
        else:
            user = auth.login_local(account, body.password or "")
        token = auth.issue(user["id"])
        return {
            "token": token,
            "user": public_user(user),
            "onboarding": chat.onboarding_status(user["id"]),
        }

    @router.get("/me")
    def me(request: Request):
        user = auth.require_user(request)
        return {"user": public_user(user), "onboarding": chat.onboarding_status(user["id"])}

    @router.patch("/me")
    def patch_me(request: Request, body: PatchMe):
        user = auth.require_user(request)
        updated = user
        if body.current_password is not None or body.new_password is not None:
            updated = auth.change_password(user["id"], body.current_password or "", body.new_password or "")
        if body.display_name is not None:
            updated = auth.update_display_name(user["id"], body.display_name)
        if body.display_name is None and body.current_password is None and body.new_password is None:
            raise HTTPException(422, "请提供要修改的昵称或密码。")
        return {"user": public_user(updated)}

    @router.post("/logout", status_code=204)
    def logout(request: Request):
        header = request.headers.get("authorization", "").strip()
        auth.require_user(request)
        if header.lower().startswith("bearer "):
            auth.revoke(header[7:].strip())
        return Response(status_code=204)

    return router


def BooleanSmtp(settings: Settings | None) -> bool:
    if settings is None:
        return False
    return bool(
        settings.smtp_host.strip()
        and settings.smtp_user.strip()
        and settings.smtp_password.get_secret_value().strip()
    )
