import asyncio
import os
import signal
import subprocess

from app.agent_tools.guard import ToolError, enforce_security_blacklist

MAX_OUTPUT = 50_000


async def _terminate_tree(process) -> None:
    if os.name == "nt":
        killer = await asyncio.create_subprocess_exec(
            "taskkill", "/PID", str(process.pid), "/T", "/F",
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        await killer.wait()
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if process.returncode is None:
        try:
            process.kill()
        except ProcessLookupError:
            pass
    await process.wait()


async def run(root, arguments: dict) -> str:
    enforce_security_blacklist(str(arguments.get("command") or ""))
    if root is None or not root.is_dir():
        raise ToolError("还没有工作区。请先在设置里选择一个文件夹。")
    command = arguments.get("command")
    if not isinstance(command, str) or not command.strip():
        raise ToolError("缺少 command。")
    if len(command) > 8000:
        raise ToolError("命令过长。")
    timeout = arguments.get("timeout", 30)
    if not isinstance(timeout, int) or timeout < 1:
        timeout = 30
    timeout = min(timeout, 120)
    launch = asyncio.create_task(asyncio.create_subprocess_exec(
        "powershell", "-NoProfile", "-NonInteractive", "-Command", command,
        cwd=str(root.resolve()),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {"start_new_session": True}),
    ))
    try:
        process = await asyncio.shield(launch)
    except asyncio.CancelledError:
        process = await launch
        await _terminate_tree(process)
        raise
    communication = asyncio.create_task(process.communicate())
    try:
        output, _ = await asyncio.wait_for(asyncio.shield(communication), timeout)
    except (TimeoutError, asyncio.CancelledError) as exc:
        cleanup = asyncio.create_task(_terminate_tree(process))
        try:
            await asyncio.shield(cleanup)
        finally:
            await cleanup
            communication.cancel()
            await asyncio.gather(communication, return_exceptions=True)
        if isinstance(exc, asyncio.CancelledError):
            raise
        raise ToolError(f"命令超过 {timeout} 秒，已终止进程树。") from None
    text = (output or b"").decode("utf-8", "replace")
    if len(text) > MAX_OUTPUT:
        text = text[:MAX_OUTPUT] + "\n…（输出已截断）"
    status = process.returncode
    body = text.strip() or "（无输出）"
    return f"退出码 {status}\n{body}"
