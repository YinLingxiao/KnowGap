"""Exercise the actual frozen backend and exported pages using disposable data."""
import json
import os
from contextlib import closing
from pathlib import Path
import re
import socket
import sqlite3
import subprocess
import tempfile
import time
from urllib.error import URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
RESOURCES = ROOT / "desktop" / "dist" / "win-unpacked" / "resources"
EXE = RESOURCES / "backend" / "knowgap.exe"
FRONTEND = RESOURCES / "frontend"


def main():
    assert EXE.is_file(), "Packaged backend is missing"
    assert (FRONTEND / "index.html").is_file(), "Packaged frontend is missing"
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"

    def get(path, body=None, *, entry_page=False):
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"}
        if entry_page:
            # Simulate a browser revalidating an entry cached by an older package.
            headers["If-None-Match"] = "*"
            headers["If-Modified-Since"] = "Thu, 01 Jan 2099 00:00:00 GMT"
        request = Request(origin + path, data=data, headers=headers)
        with urlopen(request, timeout=3) as response:
            expected_status = 201 if body is not None else 200
            assert response.status == expected_status, (path, response.status)
            if entry_page:
                assert response.headers.get("Cache-Control") == "no-store", path
            return response.read()

    def stop(process):
        if process.poll() is None:
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                           check=True, capture_output=True, timeout=15)
        process.wait(timeout=15)

    with tempfile.TemporaryDirectory(prefix="knowgap-package-smoke-") as temporary:
        env = {**os.environ, "KNOWGAP_DATA_DIR": temporary}

        def start():
            process = subprocess.Popen([str(EXE), "--port", str(port), "--static", str(FRONTEND)],
                                       env=env, creationflags=subprocess.CREATE_NO_WINDOW)
            deadline = time.monotonic() + 45
            try:
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise RuntimeError(f"Packaged backend exited: {process.returncode}")
                    try:
                        if json.loads(get("/health"))["status"] == "ok":
                            return process
                    except (URLError, TimeoutError, OSError):
                        time.sleep(0.25)
                raise RuntimeError("Packaged backend health timeout")
            except BaseException:
                stop(process)
                raise

        process = start()
        try:
            html = get("/", entry_page=True).decode()
            get("/quick.html", entry_page=True)
            assets = set(re.findall(r'(?:src|href)="(/_next/[^"?#]+)', html))
            assert assets, "No frontend assets were exported"
            for asset in assets:
                get(asset)
            schema = json.loads(get("/openapi.json"))
            assert "/api/conversations/{conversation_id}/outbox" in schema["paths"]
            conversation = json.loads(get("/api/conversations", {"client_request_id": "package-smoke"}))
            cid = conversation["id"]
            outbox = json.loads(get(f"/api/conversations/{cid}/outbox"))
            assert outbox["items"] == [] and outbox["paused"] is False
        finally:
            stop(process)

        process = start()
        try:
            assert json.loads(get(f"/api/conversations/{cid}"))["id"] == cid
        finally:
            stop(process)
        with closing(sqlite3.connect(Path(temporary) / "knowgap.sqlite3")) as database:
            assert database.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    print("Packaged backend, assets, outbox and restart persistence: PASS (no model requests)")


if __name__ == "__main__":
    main()
