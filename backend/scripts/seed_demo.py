"""导入或清除路演用的合成演示数据。命令行入口，逻辑在 app.demo.seed。"""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.demo.seed import (  # noqa: E402
    CIRCUIT_NAME,
    DS_NAME,
    PROFILE_MARK,
    main,
    open_store,
    reset,
    resolve_db,
    seed,
)

__all__ = [
    "CIRCUIT_NAME",
    "DS_NAME",
    "PROFILE_MARK",
    "main",
    "open_store",
    "reset",
    "resolve_db",
    "seed",
]

if __name__ == "__main__":
    main()
