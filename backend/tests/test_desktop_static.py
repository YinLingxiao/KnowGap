"""Serve executable web assets independently of Windows MIME registry values."""

import mimetypes

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from desktop_entry import ExportStaticFiles


@pytest.mark.parametrize("suffix,media_type", [
    (".mjs", "text/javascript"), (".js", "text/javascript"), (".wasm", "application/wasm"),
])
def test_module_and_wasm_types_override_host_registry(tmp_path, monkeypatch, suffix, media_type):
    mimetypes.init()
    monkeypatch.setitem(mimetypes.types_map, suffix, "text/plain")
    asset = tmp_path / ("worker" + suffix)
    asset.write_bytes(b"export const value = 42;" if suffix != ".wasm" else b"\0asm\1\0\0\0")
    app = FastAPI()
    app.mount("/", ExportStaticFiles(directory=tmp_path, html=True))
    with TestClient(app) as client:
        response = client.get("/" + asset.name)
        assert response.status_code == 200 and response.content == asset.read_bytes()
        assert response.headers["content-type"].split(";")[0] == media_type
        head = client.head("/" + asset.name)
        assert head.status_code == 200 and not head.content
        assert head.headers["content-type"].split(";")[0] == media_type
        cached = client.get("/" + asset.name, headers={"If-None-Match": response.headers["etag"]})
        assert cached.status_code == 304 and not cached.content


def test_exported_pages_keep_no_store_and_extensionless_routes(tmp_path):
    (tmp_path / "index.html").write_text("<h1>Main</h1>", encoding="utf-8")
    (tmp_path / "quick.html").write_text("<h1>Quick</h1>", encoding="utf-8")
    app = FastAPI()
    app.mount("/", ExportStaticFiles(directory=tmp_path, html=True))
    with TestClient(app) as client:
        for path in ["/", "/quick", "/quick.html"]:
            response = client.get(path)
            assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
        assert client.get("/missing.mjs").status_code == 404
