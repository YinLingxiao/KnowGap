"""Start a real local HTTP server against a temporary DB, then stop it.

Does not call a real model. Does not touch backend/data or a filled .env.
"""

import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time

import httpx


def main():
    backend_root = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="knowgap-http-check-") as temporary:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        env = os.environ.copy()
        env.update({
            "DATABASE_PATH": str(Path(temporary) / "smoke.sqlite3"),
            "LLM_API_KEY": "", "OPENAI_API_KEY": "", "LLM_BASE_URL": "",
            "OPENAI_BASE_URL": "", "LLM_MODEL": "",
        })
        process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port)],
            cwd=backend_root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        try:
            base = f"http://127.0.0.1:{port}"
            with httpx.Client(base_url=base, timeout=3, trust_env=False) as client:
                for attempt in range(80):
                    if process.poll() is not None:
                        raise RuntimeError("Uvicorn exited before becoming ready")
                    try:
                        ready = client.get("/health")
                        if ready.status_code == 200:
                            break
                    except httpx.RequestError:
                        pass
                    time.sleep(0.1)
                else:
                    raise RuntimeError("Uvicorn did not become ready")
                assert ready.json() == {"status": "ok"}
                assert len(client.get("/api/problems").json()) == 3
                assert client.get("/api/memories").json() == []
                assert len(client.get("/openapi.json").json()["paths"]) == 7
                response = client.post("/api/diagnosis", json={
                    "problem_id": "stack-sequence-001", "answer": "合法，因为数字集合相同。",
                })
                assert response.status_code == 503
                assert client.get("/api/memories").json() == []
                print("Real HTTP smoke passed: health, 3 problems, memories, 7-path OpenAPI, unconfigured model 503.")
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


if __name__ == "__main__":
    main()
