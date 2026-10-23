# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules

# reportlab 的字体与 PDF 对象模块按名字动态加载；pypdfium2 自带 pdfium 动态库
hidden = collect_submodules("app") + collect_submodules("reportlab") + collect_submodules("pypdfium2") + collect_submodules("google.auth") + collect_submodules("google.oauth2") + collect_submodules("jwt") + [
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.lifespan.on",
    "multipart",
]

a = Analysis(
    ["desktop_entry.py"],
    pathex=["."],
    binaries=collect_dynamic_libs("pypdfium2_raw") + collect_dynamic_libs("pypdfium2"),
    datas=collect_data_files("reportlab") + collect_data_files("pypdfium2") + collect_data_files("pypdfium2_raw"),
    hiddenimports=hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="knowgap",
    icon="icon.ico",
    console=False,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="knowgap",
)
