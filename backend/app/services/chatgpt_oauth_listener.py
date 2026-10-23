"""Short-lived loopback callback listener for ChatGPT OAuth (no app auth middleware)."""

import html
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from app.agents.llm import ProviderError


def _page(ok: bool, message: str) -> bytes:
    title = "授权完成" if ok else "授权未完成"
    return (f"<!doctype html><html lang='zh-CN'><meta charset='utf-8'><title>{title}</title>"
            "<style>body{font:15px/1.7 system-ui,'Microsoft YaHei',sans-serif;max-width:560px;margin:14vh auto;"
            "padding:0 24px;color:#222}h1{font-size:20px}p{color:#555}</style>"
            f"<h1>{title}</h1><p>{html.escape(message)}</p><p>可以关闭此页面，回到 KnowGap。</p></html>").encode("utf-8")


class OAuthListener:
    def __init__(self, auth, redirect_uri: str):
        parsed = urlsplit(redirect_uri)
        self.auth = auth
        self.redirect_uri = redirect_uri
        self.path = parsed.path
        self.server = ThreadingHTTPServer(("127.0.0.1", parsed.port), self._handler())
        self.thread = threading.Thread(target=self.server.serve_forever, name="chatgpt-oauth", daemon=True)

    def _handler(listener):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                return

            def do_GET(self):
                parsed = urlsplit(self.path)
                if parsed.path != listener.path:
                    self.send_error(404)
                    return
                if self.client_address[0] not in {"127.0.0.1", "::1"}:
                    self.send_error(403)
                    return
                query = {key: values[-1] for key, values in parse_qs(parsed.query).items()}
                ok, message = True, "ChatGPT 已连接，可以返回 KnowGap。"
                try:
                    listener.auth.complete(query)
                except ProviderError as exc:
                    ok, message = False, exc.detail
                    listener.auth.last_error = exc.detail
                except Exception:
                    ok, message = False, "授权处理失败，请回到 KnowGap 重新连接。"
                    listener.auth.last_error = message
                body = _page(ok, message)
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
                self.end_headers()
                self.wfile.write(body)
                threading.Thread(target=self.server.shutdown, daemon=True).start()
        return Handler

    def start(self) -> None:
        self.thread.start()

    def shutdown(self) -> None:
        self.server.shutdown()

    def server_close(self) -> None:
        self.server.server_close()


def start_listener(auth, preferred_port: int = 1455) -> str:
    last = None
    for port in range(preferred_port, preferred_port + 12):
        redirect = f"http://127.0.0.1:{port}/auth/callback"
        try:
            listener = OAuthListener(auth, redirect)
        except OSError as exc:
            last = exc
            continue
        auth.listener = listener
        listener.start()
        return redirect
    raise ProviderError(503, "无法启动本机 ChatGPT 登录回调端口，请关闭占用 1455–1466 端口的程序后重试。") from last
