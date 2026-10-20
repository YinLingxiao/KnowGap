"""在隔离临时目录里用受限子进程编译 / 运行学生代码，返回真实的编译器与程序输出。

流程：黑名单（命中即返回，不起任何进程）-> 写入临时目录 -> 语法检查 / 编译 ->
逐个用例运行并比对输出 -> 清理临时目录。

隔离手段（尽力而为，不是容器级隔离）：
- 每次运行一个全新的临时目录，结束后删除；输出里的临时目录路径会被抹掉。
- 子进程环境变量只给白名单，不继承宿主的密钥、令牌。
- 每个用例 3 秒墙钟超时，超时杀整棵进程树；单个输出流最多 64 KiB，超出即杀进程。
- Windows：Job Object 限制内存、禁止再创建子进程（运行阶段），进程树随 Job 一起终止。
- POSIX：新会话 + setrlimit（CPU、文件大小、core；非 node 再加地址空间）+ killpg。该分支只做了
  设计，没有在 POSIX 机器上验证过。
- Node.js 使用 --permission 限制文件系统读取（不支持时自动不加）。

残余风险：Python 与 C/C++ 的文件读取、网络外联没有操作系统级隔离，黑名单只是提示层。
所以它只适合本机单用户演示；任何对外或多用户部署必须先放进容器。
"""

from __future__ import annotations

import functools
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from app.code_sandbox.blacklist import check_security_blacklist
from app.code_sandbox.schemas import (
    BlockedRule, CaseResult, CompileResult, Diagnostic, RunRequest, RunResponse,
)

logger = logging.getLogger(__name__)

TIME_LIMIT_SECONDS = 3.0
COMPILE_TIMEOUT_SECONDS = 15.0
TOTAL_DEADLINE_SECONDS = 25.0
MAX_STREAM_BYTES = 64 * 1024
RUN_MEMORY_BYTES = 256 * 1024 * 1024
NODE_MEMORY_BYTES = 512 * 1024 * 1024
COMPILE_MEMORY_BYTES = 1024 * 1024 * 1024
TRUNCATED_NOTE = "\n…（输出过长，已截断）"
IS_WINDOWS = os.name == "nt"


class ToolchainMissing(RuntimeError):
    """本机缺少运行某种语言所需的编译器 / 解释器。"""


# ------------------------------------------------------------------ 工具链

@dataclass(frozen=True)
class Toolchain:
    language: str
    source_name: str
    compiler: str | None  # C/C++ 的编译器路径
    interpreter: str | None  # python / node 的路径

    @property
    def tool_dir(self) -> str | None:
        path = self.compiler or None
        return str(Path(path).parent) if path else None


def _usable(path: str | None) -> bool:
    if not path:
        return False
    # Windows 商店的 python.exe 占位符会弹出商店，不是真的解释器。
    return "windowsapps" not in path.lower()


def _python_executable() -> str | None:
    if not getattr(sys, "frozen", False):
        # venv 里的 python.exe 只是启动器：会多出一个进程，也会让学生代码 import 到 venv 里的 fastapi。
        base = getattr(sys, "_base_executable", None) or sys.executable
        if base and Path(base).exists():
            return base
    for name in ("python", "python3"):
        found = shutil.which(name)
        if _usable(found):
            return found
    return None


def get_toolchain(language: str) -> Toolchain:
    if language == "python":
        path = _python_executable()
        if not path:
            raise ToolchainMissing("找不到 Python 解释器，无法运行 Python 代码。")
        return Toolchain(language, "main.py", None, path)
    if language == "javascript":
        path = shutil.which("node")
        if not path:
            raise ToolchainMissing("找不到 node，无法运行 JavaScript 代码。请安装 Node.js 并加入 PATH。")
        return Toolchain(language, "main.js", None, path)
    if language in ("c", "cpp"):
        name = "gcc" if language == "c" else "g++"
        path = shutil.which(name)
        if not path:
            raise ToolchainMissing(
                f"找不到 {name}，无法编译 {'C' if language == 'c' else 'C++'} 代码。"
                "请安装 MinGW-w64（或 MSYS2 的 ucrt64 工具链）并把它加入 PATH。")
        return Toolchain(language, "main.c" if language == "c" else "main.cpp", path, None)
    raise ToolchainMissing(f"不支持的语言：{language}")


@functools.lru_cache(maxsize=4)
def _node_supports_permission(node: str) -> bool:
    try:
        result = subprocess.run(
            [node, "--permission", "-e", "0"], capture_output=True, timeout=10,
            creationflags=subprocess.CREATE_NO_WINDOW if IS_WINDOWS else 0,
        )
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


# --------------------------------------------------------- Windows Job Object

if IS_WINDOWS:
    import ctypes
    from ctypes import wintypes

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    class _IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class _BasicLimit(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD),
        ]

    class _ExtendedLimit(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", _BasicLimit), ("IoInfo", _IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    _kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    _kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    _kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    _kernel32.SetInformationJobObject.restype = wintypes.BOOL
    _kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    _kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    _kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    _kernel32.TerminateJobObject.restype = wintypes.BOOL
    _kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    _kernel32.CloseHandle.restype = wintypes.BOOL

    _JOB_LIMIT_ACTIVE_PROCESS = 0x00000008
    _JOB_LIMIT_PROCESS_MEMORY = 0x00000100
    _JOB_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x00000400
    _JOB_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
    _EXTENDED_LIMIT_INFORMATION = 9
    _kernel32.SetErrorMode(0x0001 | 0x0002)


class _Job:
    """Windows Job Object 的薄封装。创建或分配失败时调用方降级为只用 taskkill。"""

    def __init__(self, handle) -> None:
        self.handle = handle
        self.closed = False

    @classmethod
    def create(cls, *, memory_limit: int | None, active_process_limit: int | None) -> "_Job | None":
        if not IS_WINDOWS:
            return None
        handle = _kernel32.CreateJobObjectW(None, None)
        if not handle:
            logger.warning("CreateJobObjectW 失败（%s），降级为 taskkill", ctypes.get_last_error())
            return None
        info = _ExtendedLimit()
        flags = _JOB_LIMIT_KILL_ON_JOB_CLOSE | _JOB_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
        if memory_limit:
            flags |= _JOB_LIMIT_PROCESS_MEMORY
            info.ProcessMemoryLimit = memory_limit
        if active_process_limit:
            flags |= _JOB_LIMIT_ACTIVE_PROCESS
            info.BasicLimitInformation.ActiveProcessLimit = active_process_limit
        info.BasicLimitInformation.LimitFlags = flags
        if not _kernel32.SetInformationJobObject(
                handle, _EXTENDED_LIMIT_INFORMATION, ctypes.byref(info), ctypes.sizeof(info)):
            logger.warning("SetInformationJobObject 失败（%s），降级为 taskkill", ctypes.get_last_error())
            _kernel32.CloseHandle(handle)
            return None
        return cls(handle)

    def assign(self, process: subprocess.Popen) -> bool:
        # Popen 与分配之间有极短的竞态；3 秒超时、KILL_ON_JOB_CLOSE 和 taskkill 兜底。
        ok = _kernel32.AssignProcessToJobObject(self.handle, wintypes.HANDLE(int(process._handle)))
        if not ok:
            logger.debug("AssignProcessToJobObject 失败（%s）", ctypes.get_last_error())
        return bool(ok)

    def terminate(self) -> None:
        if not self.closed:
            _kernel32.TerminateJobObject(self.handle, 1)

    def close(self) -> None:
        if not self.closed:
            self.closed = True
            _kernel32.TerminateJobObject(self.handle, 1)
            _kernel32.CloseHandle(self.handle)


# --------------------------------------------------------------- 子进程执行

@dataclass
class ProcResult:
    stdout: str = ""
    stderr: str = ""
    exit_code: int | None = None
    timed_out: bool = False
    truncated: bool = False
    duration_ms: int = 0
    launch_error: str | None = None


class _Sink:
    def __init__(self) -> None:
        self.chunks: list[bytes] = []
        self.size = 0
        self.truncated = False

    def text(self) -> str:
        return b"".join(self.chunks).decode("utf-8", errors="replace")


def _kill_tree(process: subprocess.Popen, job: _Job | None) -> None:
    if IS_WINDOWS:
        if job is not None:
            job.terminate()
        else:
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, timeout=5,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
            except (OSError, subprocess.SubprocessError):
                pass
    else:
        import signal
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
    try:
        process.kill()
    except OSError:
        pass


def _posix_preexec(memory_limit: int | None, cpu_seconds: int):
    def apply() -> None:  # 在子进程里 exec 之前执行
        import resource
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
        resource.setrlimit(resource.RLIMIT_FSIZE, (10 * 1024 * 1024, 10 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        if memory_limit:
            resource.setrlimit(resource.RLIMIT_AS, (memory_limit, memory_limit))
    return apply


def _pump(stream, sink: _Sink, on_overflow) -> None:
    try:
        while True:
            chunk = stream.read(8192)
            if not chunk:
                break
            room = MAX_STREAM_BYTES - sink.size
            if room > 0:
                sink.chunks.append(chunk[:room])
                sink.size += min(len(chunk), room)
            if len(chunk) > room:
                sink.truncated = True
                on_overflow()
                break
    except (OSError, ValueError):
        pass


def _feed(stream, data: bytes) -> None:
    try:
        if data:
            stream.write(data)
    except (BrokenPipeError, OSError, ValueError):
        pass
    finally:
        try:
            stream.close()
        except (OSError, ValueError):
            pass


def _run_process(
    command: list[str], *, cwd: Path, env: dict[str, str], stdin_data: bytes, timeout: float,
    memory_limit: int | None, active_process_limit: int | None, posix_address_space: bool = True,
) -> ProcResult:
    started = time.monotonic()
    job = _Job.create(memory_limit=memory_limit, active_process_limit=active_process_limit)
    popen_kwargs: dict = {}
    if IS_WINDOWS:
        popen_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    else:
        popen_kwargs["start_new_session"] = True
        popen_kwargs["preexec_fn"] = _posix_preexec(
            memory_limit if posix_address_space else None, max(2, int(timeout) + 2))
    try:
        process = subprocess.Popen(
            command, cwd=str(cwd), env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, bufsize=0, **popen_kwargs,
        )
    except OSError as exc:
        if job is not None:
            job.close()
        return ProcResult(launch_error=f"无法启动程序：{exc.strerror or exc}",
                          duration_ms=int((time.monotonic() - started) * 1000))
    try:
        if job is not None and not job.assign(process):
            job.close()
            job = None
        out, err = _Sink(), _Sink()
        overflow = threading.Event()

        def on_overflow() -> None:
            overflow.set()
            _kill_tree(process, job)

        threads = [
            threading.Thread(target=_pump, args=(process.stdout, out, on_overflow), daemon=True),
            threading.Thread(target=_pump, args=(process.stderr, err, on_overflow), daemon=True),
            threading.Thread(target=_feed, args=(process.stdin, stdin_data), daemon=True),
        ]
        for thread in threads:
            thread.start()
        timed_out = False
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            _kill_tree(process, job)
            process.wait()
        for thread in threads:
            thread.join(timeout=2)
        killed = timed_out or overflow.is_set()
        return ProcResult(
            stdout=out.text(), stderr=err.text(), exit_code=None if killed else process.returncode,
            timed_out=timed_out, truncated=out.truncated or err.truncated,
            duration_ms=int((time.monotonic() - started) * 1000),
        )
    finally:
        if job is not None:
            job.close()
        else:
            _kill_tree(process, None)
        for stream in (process.stdin, process.stdout, process.stderr):
            try:
                stream.close()
            except (OSError, ValueError):
                pass


def _sandbox_env(workdir: Path, extra_path: str | None = None) -> dict[str, str]:
    """只给白名单环境变量，不继承宿主的密钥与令牌。"""
    if IS_WINDOWS:
        root = os.environ.get("SYSTEMROOT") or os.environ.get("SystemRoot") or r"C:\Windows"
        path = os.pathsep.join(filter(None, [extra_path, rf"{root}\System32", root]))
        return {"SYSTEMROOT": root, "PATH": path, "TEMP": str(workdir), "TMP": str(workdir), "LC_ALL": "C"}
    path = os.pathsep.join(filter(None, [extra_path, "/usr/bin", "/bin"]))
    return {"PATH": path, "HOME": str(workdir), "TMPDIR": str(workdir), "LC_ALL": "C", "LANG": "C"}


# ------------------------------------------------------------ 输出与诊断解析

_GCC_DIAG = re.compile(
    r"^(?:.*?[\\/])?main\.(?:c|cpp):(\d+):(?:(\d+):)?\s*(fatal error|error|warning):\s*(.*)$", re.M)
_GCC_LINK = re.compile(r"(undefined reference to [^\n]+|multiple definition of [^\n]+|cannot find -l\S+)")
_NODE_LOC = re.compile(r"main\.js:(\d+)(?::(\d+))?")
_NODE_ERR = re.compile(r"^\s*((?:\w+)?Error\b[^\n]*)$", re.M)
_PY_LOC = re.compile(r'File "(?:.*?[\\/])?main\.py", line (\d+)')
_NODE_NOISE = re.compile(
    r"ExperimentalWarning|--trace-warnings|^\s*\(Use `node|^\s+at .*node:internal|^Node\.js v\d", re.I)
_SBX_PATH = re.compile(r"(?:[A-Za-z]:)?[\\/][^\s:\"'<>|]*knowgap-sbx-[A-Za-z0-9_]+[\\/]?")


def _scrub(text: str, workdir: Path) -> str:
    """去掉临时目录的绝对路径，只留 main.xxx。"""
    variants = {str(workdir), str(workdir).replace("\\", "/"), str(workdir.resolve()),
                str(workdir.resolve()).replace("\\", "/")}
    for variant in sorted(variants, key=len, reverse=True):
        text = re.sub(re.escape(variant) + r"[\\/]?", "", text, flags=re.I)
    return _SBX_PATH.sub("", text)


def _drop_node_noise(text: str) -> str:
    return "\n".join(line for line in text.split("\n") if not _NODE_NOISE.search(line))


def _parse_diagnostics(language: str, text: str) -> list[Diagnostic]:
    found: list[Diagnostic] = []
    if language in ("c", "cpp"):
        for match in _GCC_DIAG.finditer(text):
            found.append(Diagnostic(
                line=int(match.group(1)), column=int(match.group(2)) if match.group(2) else None,
                severity="warning" if match.group(3) == "warning" else "error",
                message=match.group(4).strip()[:300],
            ))
        if not any(item.severity == "error" for item in found):
            link = _GCC_LINK.search(text)
            if link:
                found.append(Diagnostic(line=None, severity="error", message=link.group(1).strip()[:300]))
    elif language == "python":
        lines = [int(match.group(1)) for match in _PY_LOC.finditer(text)]
        if lines:
            message = next((line.strip() for line in reversed(text.splitlines()) if line.strip()), "")
            found.append(Diagnostic(line=lines[-1], severity="error", message=message[:300]))
    elif language == "javascript":
        location = _NODE_LOC.search(text)
        if location:
            error = _NODE_ERR.search(text)
            found.append(Diagnostic(
                line=int(location.group(1)), column=int(location.group(2)) if location.group(2) else None,
                severity="error", message=(error.group(1).strip() if error else "运行出错")[:300],
            ))
    seen: set[tuple] = set()
    unique: list[Diagnostic] = []
    for item in found:
        key = (item.line, item.column, item.severity, item.message)
        if key not in seen:
            seen.add(key)
            unique.append(item)
    return unique[:20]


_WINDOWS_EXIT_NOTES = {
    0xC0000005: "访问冲突：程序访问了非法内存（常见于空指针、数组越界、野指针）。",
    0xC00000FD: "栈溢出：递归太深或局部数组太大。",
    0xC0000094: "整数除以零。",
    0xC0000135: "缺少运行库 DLL，程序无法启动。",
    0xC0000017: "内存不足：超过了沙盒的内存上限。",
    0xC0000409: "栈缓冲区溢出，或程序主动中止（abort、断言失败）。",
}
_POSIX_EXIT_NOTES = {
    -11: "段错误（SIGSEGV）：访问了非法内存。",
    -6: "程序主动中止（SIGABRT）：常见于 abort 或断言失败。",
    -8: "算术错误（SIGFPE）：常见于整数除以零。",
    -9: "进程被强制终止（SIGKILL）：可能超出了时间或内存上限。",
}


def _exit_note(code: int | None) -> str | None:
    if code is None or code == 0:
        return None
    if IS_WINDOWS:
        return _WINDOWS_EXIT_NOTES.get(code & 0xFFFFFFFF)
    return _POSIX_EXIT_NOTES.get(code)


def _normalize(text: str) -> str:
    lines = [line.rstrip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def _clean_output(result: ProcResult, language: str, workdir: Path) -> tuple[str, str]:
    # Windows 文本模式会把 \n 写成 \r\n，统一回 \n，前端展示和比对都不用再处理。
    stdout = _scrub(result.stdout, workdir).replace("\r\n", "\n")
    stderr = _scrub(result.stderr, workdir).replace("\r\n", "\n")
    if language == "javascript":
        stderr = _drop_node_noise(stderr)
    if result.truncated:
        stdout += TRUNCATED_NOTE
    return stdout, stderr


# ----------------------------------------------------------------- 编译与运行

def _compile(toolchain: Toolchain, workdir: Path) -> tuple[CompileResult, list[str] | None]:
    """返回编译结果与运行命令（编译失败时为 None）。"""
    language = toolchain.language
    source = toolchain.source_name
    run_command: list[str]
    if language == "python":
        interpreter = toolchain.interpreter or ""
        command = [interpreter, "-I", "-B", "-X", "utf8", "-m", "py_compile", source]
        run_command = [interpreter, "-I", "-B", "-u", "-X", "utf8", source]
        extra_path = None
    elif language == "javascript":
        interpreter = toolchain.interpreter or ""
        command = [interpreter, "--check", source]
        run_command = [interpreter]
        if _node_supports_permission(interpreter):
            run_command += ["--permission", f"--allow-fs-read={workdir}"]
        run_command.append(source)
        extra_path = None
    else:
        compiler = toolchain.compiler or ""
        exe = workdir / ("main.exe" if IS_WINDOWS else "main")
        flags = ["-O1", "-Wall", "-fmax-errors=10"]
        flags += ["-std=c11"] if language == "c" else ["-std=c++17"]
        command = [compiler, *flags, "-static", source, "-o", str(exe)]
        if language == "c":
            command.append("-lm")
        run_command = [str(exe)]
        extra_path = toolchain.tool_dir

    result = _run_process(
        command, cwd=workdir, env=_sandbox_env(workdir, extra_path), stdin_data=b"",
        timeout=COMPILE_TIMEOUT_SECONDS, memory_limit=COMPILE_MEMORY_BYTES, active_process_limit=None,
        posix_address_space=False,
    )
    stdout, stderr = _clean_output(result, language, workdir)
    ok = result.launch_error is None and not result.timed_out and result.exit_code == 0
    if result.launch_error:
        stderr = result.launch_error
    elif result.timed_out:
        stderr = (stderr + "\n" if stderr else "") + f"编译超过 {int(COMPILE_TIMEOUT_SECONDS)} 秒，已终止。"
    diagnostics = _parse_diagnostics(language, stdout + "\n" + stderr)
    if not ok and not any(item.severity == "error" for item in diagnostics):
        message = next((line.strip() for line in reversed((stderr or stdout).splitlines()) if line.strip()),
                       "编译失败")
        diagnostics.append(Diagnostic(line=None, severity="error", message=message[:300]))
    compile_result = CompileResult(
        ok=ok, stdout=stdout, stderr=stderr, diagnostics=diagnostics, duration_ms=result.duration_ms,
    )
    return compile_result, (run_command if ok else None)


def _run_case(
    index: int, name: str, stdin: str, expected: str | None, command: list[str],
    toolchain: Toolchain, workdir: Path, timeout: float,
) -> CaseResult:
    memory = NODE_MEMORY_BYTES if toolchain.language == "javascript" else RUN_MEMORY_BYTES
    result = _run_process(
        command, cwd=workdir, env=_sandbox_env(workdir), stdin_data=stdin.encode("utf-8"),
        timeout=timeout, memory_limit=memory, active_process_limit=1,
        posix_address_space=toolchain.language != "javascript",
    )
    stdout, stderr = _clean_output(result, toolchain.language, workdir)
    if result.launch_error:
        stderr = result.launch_error
    passed: bool | None = None
    if result.timed_out:
        status = "timeout"
        passed = False if expected is not None else None
    elif result.truncated:
        status = "output_limit"
        passed = False if expected is not None else None
    elif result.launch_error or result.exit_code != 0:
        status = "runtime_error"
        passed = False if expected is not None else None
    elif expected is not None:
        passed = _normalize(stdout) == _normalize(expected)
        status = "passed" if passed else "failed"
    else:
        status = "ok"
    diagnostics: list[Diagnostic] = []
    if status in ("runtime_error", "timeout"):
        diagnostics = _parse_diagnostics(toolchain.language, stderr)
    return CaseResult(
        index=index, name=name, input=stdin, expected=expected, status=status, passed=passed,
        stdout=stdout, stderr=stderr, exit_code=result.exit_code, exit_note=_exit_note(result.exit_code),
        duration_ms=result.duration_ms, truncated=result.truncated, timed_out=result.timed_out,
        diagnostics=diagnostics,
    )


def _skipped(index: int, name: str, stdin: str, expected: str | None) -> CaseResult:
    return CaseResult(
        index=index, name=name, input=stdin, expected=expected, status="skipped",
        passed=False if expected is not None else None, stdout="", stderr="本用例因总时限用完而未运行。",
        exit_code=None, exit_note=None, duration_ms=0, truncated=False, timed_out=False, diagnostics=[],
    )


def _blocked_response(request: RunRequest, hits: list[BlockedRule]) -> RunResponse:
    names = "、".join(f"{hit.rule_id}（第 {hit.line} 行）" for hit in hits[:5])
    more = f" 等 {len(hits)} 条" if len(hits) > 5 else ""
    return RunResponse(
        ok=False, status="blocked",
        message=f"代码触发了安全黑名单，未执行：{names}{more}。沙盒里不允许删除文件、读环境变量、联网或启动子进程。",
        language=request.language, stdout="", stderr="", exit_code=-1, blocked=hits, compile=None,
        test_results=[], passed=0, total=0,
        diagnostics=[Diagnostic(line=hit.line, severity="error", message=f"{hit.rule_id}：{hit.description}")
                     for hit in hits],
        time_limit_seconds=TIME_LIMIT_SECONDS,
    )


def _cleanup(path: Path) -> None:
    for _ in range(6):
        try:
            shutil.rmtree(path)
            return
        except FileNotFoundError:
            return
        except OSError:
            time.sleep(0.1)  # 杀毒软件或刚结束的进程可能还占着文件
    shutil.rmtree(path, ignore_errors=True)


def run_sandbox(request: RunRequest) -> RunResponse:
    """同步执行，调用方（router）负责放进线程池。工具链缺失时抛 ToolchainMissing。"""
    hits = check_security_blacklist(request.code, request.language)
    if hits:
        return _blocked_response(request, hits)
    toolchain = get_toolchain(request.language)

    workdir = Path(tempfile.mkdtemp(prefix="knowgap-sbx-")).resolve()
    try:
        (workdir / toolchain.source_name).write_text(request.code, encoding="utf-8", newline="\n")
        deadline = time.monotonic() + TOTAL_DEADLINE_SECONDS
        compile_result, run_command = _compile(toolchain, workdir)
        if run_command is None:
            return RunResponse(
                ok=False, status="compile_error",
                message=("语法检查没有通过。" if request.language in ("python", "javascript") else "编译失败。")
                        + "请根据下面的报错修改代码。",
                language=request.language, stdout=compile_result.stdout, stderr=compile_result.stderr,
                exit_code=-1, blocked=[], compile=compile_result, test_results=[], passed=0, total=0,
                diagnostics=compile_result.diagnostics, time_limit_seconds=TIME_LIMIT_SECONDS,
            )

        plan = (
            [(case.name or f"用例 {number}", case.input, case.expected)
             for number, case in enumerate(request.test_cases, start=1)]
            if request.test_cases else [("运行", request.stdin, None)]
        )
        cases: list[CaseResult] = []
        for index, (name, stdin, expected) in enumerate(plan):
            remaining = deadline - time.monotonic()
            if remaining < 0.3:
                cases.append(_skipped(index, name, stdin, expected))
                continue
            cases.append(_run_case(index, name, stdin, expected, run_command, toolchain, workdir,
                                   min(TIME_LIMIT_SECONDS, remaining)))
        return _assemble(request, compile_result, cases)
    finally:
        _cleanup(workdir)


def _assemble(request: RunRequest, compile_result: CompileResult, cases: list[CaseResult]) -> RunResponse:
    graded = [case for case in cases if case.expected is not None]
    passed = sum(1 for case in graded if case.passed)
    statuses = {case.status for case in cases}
    if "skipped" in statuses or "timeout" in statuses:
        status, message = "timeout", (
            f"运行超过 {int(TIME_LIMIT_SECONDS)} 秒被终止，请检查是否有死循环或等待输入。"
            if "timeout" in statuses else "总时限用完，部分用例没有运行。")
    elif statuses & {"runtime_error", "output_limit"}:
        status = "runtime_error"
        message = "程序运行时出错，请看下面的报错。" if "runtime_error" in statuses else "输出太多，已被终止。"
    elif "failed" in statuses:
        status, message = "failed", f"{passed}/{len(graded)} 个测试用例通过，输出和预期不一致。"
    elif graded:
        status, message = "passed", f"全部 {len(graded)} 个测试用例通过。"
    else:
        status, message = "ok", "运行完成。"

    focus = next((case for case in cases if case.status not in ("passed", "ok")), cases[0])
    diagnostics = list(compile_result.diagnostics)
    for case in cases:
        if case.status not in ("passed", "ok") and case.diagnostics:
            diagnostics.extend(case.diagnostics)
            break
    return RunResponse(
        ok=status in ("ok", "passed"), status=status, message=message, language=request.language,
        stdout=focus.stdout, stderr=focus.stderr,
        exit_code=focus.exit_code if focus.exit_code is not None else -1,
        blocked=[], compile=compile_result, test_results=cases, passed=passed, total=len(graded),
        diagnostics=diagnostics, time_limit_seconds=TIME_LIMIT_SECONDS,
    )
