"""Small atomic file helpers shared by the vision store and settings."""

import json
import os
import tempfile
import time
from pathlib import Path

READ_ATTEMPTS = 4


def atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if Path(temporary).exists():
            Path(temporary).unlink()


def atomic_write_json(path: Path, payload) -> None:
    atomic_write_bytes(path, json.dumps(payload, ensure_ascii=False).encode("utf-8"))


def read_json(path: Path) -> dict | None:
    # On Windows a concurrent os.replace can briefly make the file unreadable; retry a few times.
    for attempt in range(READ_ATTEMPTS):
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else None
        except OSError:
            if attempt == READ_ATTEMPTS - 1:
                return None
            time.sleep(0.02 * (attempt + 1))
        except ValueError:
            return None
    return None
