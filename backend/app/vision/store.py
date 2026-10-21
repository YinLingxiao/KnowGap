"""Per-student storage for uploaded images, cached extractions, analyses and netlist versions.

Files live next to the SQLite database under vision/<sha256(student)>/ so one student can never
address another's data, even with a guessed id. Ids are random and validated before touching disk.
Uploading the same bytes twice returns the same image id, so the extraction cache is reused.
"""

import base64
import hashlib
import re
import secrets
import struct
import time
from pathlib import Path
from threading import RLock

from app.vision._fs import atomic_write_bytes, atomic_write_json, read_json
from app.vision.schemas import MAX_IMAGE_BYTES

MAX_SIDE = 12000
IMAGE_ID_RE = re.compile(r"^img_[A-Za-z0-9_-]{16,40}$")
NETLIST_ID_RE = re.compile(r"^net_[A-Za-z0-9_-]{16,40}$")
ANALYSIS_ID_RE = re.compile(r"^ana_[A-Za-z0-9_-]{16,40}$")


class ImageRejected(ValueError):
    def __init__(self, message: str, status: int = 415):
        super().__init__(message)
        self.status = status


class VersionConflict(ValueError):
    pass


def _png_size(data: bytes):
    if len(data) >= 24 and data[12:16] == b"IHDR":
        return struct.unpack(">II", data[16:24])
    return None


def _jpeg_size(data: bytes):
    index = 2
    while index + 9 < len(data):
        if data[index] != 0xFF:
            index += 1
            continue
        marker = data[index + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7 or marker == 0xFF:
            index += 1 if marker == 0xFF else 2
            continue
        length = struct.unpack(">H", data[index + 2:index + 4])[0]
        # SOF0-SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            height, width = struct.unpack(">HH", data[index + 5:index + 9])
            return width, height
        index += 2 + length
    return None


def _webp_size(data: bytes):
    chunk = data[12:16]
    if chunk == b"VP8X" and len(data) >= 30:
        return int.from_bytes(data[24:27], "little") + 1, int.from_bytes(data[27:30], "little") + 1
    if chunk == b"VP8L" and len(data) >= 25 and data[20] == 0x2F:
        bits = int.from_bytes(data[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if chunk == b"VP8 " and len(data) >= 30 and data[23:26] == b"\x9d\x01\x2a":
        width, height = struct.unpack("<HH", data[26:30])
        return width & 0x3FFF, height & 0x3FFF
    return None


def sniff_image(data: bytes) -> tuple[str, int, int]:
    """Identify by content, never by filename or client MIME. Returns (mime, width, height)."""
    if len(data) > MAX_IMAGE_BYTES:
        raise ImageRejected("图片不能超过 10 MB，请压缩或裁剪后再上传。", 413)
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        mime, size = "image/png", _png_size(data)
    elif data.startswith(b"\xff\xd8\xff"):
        mime, size = "image/jpeg", _jpeg_size(data)
    elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        mime, size = "image/webp", _webp_size(data)
    else:
        raise ImageRejected("只支持 PNG、JPEG 或 WebP 图片。")
    if not size or not all(0 < side <= MAX_SIDE for side in size):
        raise ImageRejected("图片文件已损坏或尺寸无效。")
    return mime, size[0], size[1]


def _new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(18)}"


class VisionStore:
    def __init__(self, data_dir: Path):
        self.root = Path(data_dir) / "vision"
        self.lock = RLock()

    @classmethod
    def for_app(cls, settings) -> "VisionStore":
        return cls(settings.resolved_database_path().parent)

    def _dir(self, student_id: str) -> Path:
        return self.root / hashlib.sha256(student_id.encode("utf-8")).hexdigest()[:32]

    # ---- images ----
    def save_image(self, student_id: str, data: bytes) -> dict:
        mime, width, height = sniff_image(data)
        digest = hashlib.sha256(data).hexdigest()
        folder = self._dir(student_id) / "images"
        with self.lock:
            index = read_json(folder / "index.json") or {}
            existing = self.image_meta(student_id, index.get(digest, ""))
            if existing:
                return existing
            image_id = _new_id("img")
            atomic_write_bytes(folder / f"{image_id}.bin", data)
            meta = {"image_id": image_id, "mime": mime, "width": width, "height": height,
                    "bytes": len(data), "created_at": time.time()}
            atomic_write_json(folder / f"{image_id}.json", meta)
            index[digest] = image_id
            atomic_write_json(folder / "index.json", index)
            return meta

    def image_meta(self, student_id: str, image_id: str) -> dict | None:
        if not IMAGE_ID_RE.fullmatch(image_id or ""):
            return None
        return read_json(self._dir(student_id) / "images" / f"{image_id}.json")

    def image(self, student_id: str, image_id: str) -> tuple[bytes, dict] | None:
        meta = self.image_meta(student_id, image_id)
        if meta is None:
            return None
        try:
            return (self._dir(student_id) / "images" / f"{image_id}.bin").read_bytes(), meta
        except OSError:
            return None

    def data_url(self, student_id: str, image_id: str) -> tuple[str, dict] | None:
        found = self.image(student_id, image_id)
        if found is None:
            return None
        data, meta = found
        return f"data:{meta['mime']};base64,{base64.b64encode(data).decode('ascii')}", meta

    # ---- cached extraction (so analyzing the same image again never re-calls the vision model) ----
    def _cache_path(self, student_id: str, image_id: str, key: str) -> Path | None:
        if not IMAGE_ID_RE.fullmatch(image_id or ""):
            return None
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
        return self._dir(student_id) / "extractions" / f"{image_id}-{digest}.json"

    def cached_extraction(self, student_id: str, image_id: str, key: str) -> dict | None:
        path = self._cache_path(student_id, image_id, key)
        cached = read_json(path) if path else None
        return cached.get("extraction") if cached and cached.get("key") == key else None

    def cache_extraction(self, student_id: str, image_id: str, key: str, extraction: dict) -> None:
        path = self._cache_path(student_id, image_id, key)
        if path:
            atomic_write_json(path, {"key": key, "extraction": extraction})

    # ---- analyses: the authoritative copy of an annotation card ----
    def save_analysis(self, student_id: str, widget: dict) -> str:
        analysis_id = _new_id("ana")
        atomic_write_json(self._dir(student_id) / "analyses" / f"{analysis_id}.json",
                          {"analysis_id": analysis_id, "widget": widget, "created_at": time.time()})
        return analysis_id

    def analysis(self, student_id: str, analysis_id: str) -> dict | None:
        if not ANALYSIS_ID_RE.fullmatch(analysis_id or ""):
            return None
        return read_json(self._dir(student_id) / "analyses" / f"{analysis_id}.json")

    # ---- netlists ----
    def _netlist_path(self, student_id: str, netlist_id: str) -> Path | None:
        if not NETLIST_ID_RE.fullmatch(netlist_id or ""):
            return None
        return self._dir(student_id) / "netlists" / f"{netlist_id}.json"

    def create_netlist(self, student_id: str, image_id: str | None, netlist: dict, *, key: str | None = None) -> dict:
        """`key` makes creation idempotent (same image -> same card, including the student's corrections)."""
        with self.lock:
            index_path = self._dir(student_id) / "netlists" / "index.json"
            index = read_json(index_path) or {}
            if key and key in index:
                existing = self.netlist(student_id, index[key])
                if existing:
                    return existing
            record = {"netlist_id": _new_id("net"), "image_id": image_id, "version": 1, "confirmed": False,
                      "versions": {"1": netlist}, "updated_at": time.time()}
            atomic_write_json(self._netlist_path(student_id, record["netlist_id"]), record)
            if key:
                index[key] = record["netlist_id"]
                atomic_write_json(index_path, index)
            return record

    def netlist(self, student_id: str, netlist_id: str) -> dict | None:
        path = self._netlist_path(student_id, netlist_id)
        return read_json(path) if path else None

    def netlist_version(self, student_id: str, netlist_id: str, version: int) -> tuple[dict, bool] | None:
        """Returns (netlist, confirmed) for one version. Only the latest version can be confirmed."""
        record = self.netlist(student_id, netlist_id)
        if not record or str(version) not in record["versions"]:
            return None
        return record["versions"][str(version)], record["confirmed"] and record["version"] == version

    def confirm_netlist(self, student_id: str, netlist_id: str, version: int, netlist: dict | None) -> dict:
        """Confirm as-is (netlist=None) or with corrections (new version). Stale cards are rejected."""
        with self.lock:
            record = self.netlist(student_id, netlist_id)
            if record is None:
                raise LookupError("网表不存在或已删除。")
            if version != record["version"]:
                raise VersionConflict("这张拓扑卡已经更新过，请在最新的卡片上确认。")
            if netlist is not None and netlist != record["versions"][str(version)]:
                record["version"] = version + 1
                record["versions"][str(record["version"])] = netlist
            elif record["confirmed"]:
                return record  # double click: idempotent
            record["confirmed"] = True
            record["updated_at"] = time.time()
            atomic_write_json(self._netlist_path(student_id, netlist_id), record)
            return record
