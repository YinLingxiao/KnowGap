"""17 条不可绕过的安全黑名单（五大类：文件破坏、环境变量、网络外联、进程与系统、动态代码）。

借鉴 LobeHub 的 DEFAULT_SECURITY_BLACKLIST 思路：在执行器最前端做正则短路拦截，
任何请求参数都无法跳过。LobeHub 原文没能取到，规则按其公开的分类自行编写，
整张规则表集中在本文件，日后可以整体替换。

这是提示层而不是安全边界：字符串拼接、getattr、宏拼接等写法仍可绕过，
真正的隔离靠 runner.py 的临时目录、环境变量白名单、超时与 Job Object。

实现取舍：
- 一条规则可以按语言挂多个正则（RuleVariant），这样 `remove("x")` 只对 C/C++ 生效，
  不会误伤 Python 的 `list.remove`。规则总数仍然恰好 17 条。
- 扫描前做 NFKC 归一化、去掉不可见格式字符、合并续行（保留行号映射）、
  保守剥离注释（解析有歧义就回退扫描原文）、解码 JS 的 \\uXXXX 转义。
- 字符串字面量不剥离（f-string 与模板字符串里可以藏代码），所以 `print("os.system")`
  这类字面量会被误报，已接受。
- 正则全部有界、无嵌套量词，避免回溯爆炸。参数相关的规则（例如 open 的写模式）
  只看同一行，跨行拆写的调用可能漏掉。
"""

from __future__ import annotations

import bisect
import re
import unicodedata
from dataclasses import dataclass

from app.code_sandbox.schemas import BlockedRule, normalize_language

ALL = ("python", "javascript", "c", "cpp")
PY = ("python",)
JS = ("javascript",)
CC = ("c", "cpp")

MAX_EXCERPT = 120


@dataclass(frozen=True)
class RuleVariant:
    languages: tuple[str, ...]
    pattern: re.Pattern[str]


@dataclass(frozen=True)
class SecurityRule:
    rule_id: str
    category: str
    description: str
    variants: tuple[RuleVariant, ...]

    @property
    def languages(self) -> tuple[str, ...]:
        seen: list[str] = []
        for variant in self.variants:
            for language in variant.languages:
                if language not in seen:
                    seen.append(language)
        return tuple(seen)


def _v(languages: tuple[str, ...], pattern: str, flags: int = 0) -> RuleVariant:
    return RuleVariant(languages, re.compile(pattern, flags))


_PY_NET_MODULES = (
    r"socket|ssl|requests|httpx|aiohttp|urllib3|urllib\.request|urllib\.urlopen|http\.client|http\.server|"
    r"ftplib|smtplib|poplib|imaplib|nntplib|telnetlib|websockets?|paramiko|xmlrpc(?:\.\w+)?|socketserver|"
    r"smtpd|asyncore|asynchat|webbrowser|selectors|pycurl|scapy|twisted|tornado|flask|fastapi|django|"
    r"uvicorn|grpc"
)
_PY_OS_PROC = r"system|popen|exec\w*|spawn\w*|posix_spawn\w*|fork|forkpty|kill|killpg|startfile|abort"

DEFAULT_SECURITY_BLACKLIST: tuple[SecurityRule, ...] = (
    # ---------------------------------------------------------------- 文件破坏
    SecurityRule("FS-01", "文件破坏", "禁止删除或格式化文件系统的命令（rm -rf、del /f、format、mkfs、dd if=）。", (
        _v(ALL, (
            r"\brm[ \t]+(?:-[a-z]*[rf]|--(?:recursive|force)\b)"
            r"|\brmdir[ \t]+/s\b"
            r"|\b(?:del|erase)[ \t]+/[fsq]\b"
            r"|\bformat[ \t]+[a-z]:"
            r"|\bmkfs(?:\.\w+)?\b"
            r"|\bdd[ \t]+if="
            r"|\bRemove-Item\b"
            r"|\bshred[ \t]+-"
        ), re.I),
    )),
    SecurityRule("FS-02", "文件破坏", "禁止调用删除文件或目录的 API。", (
        _v(PY, (
            r"\bos\.(?:remove|unlink|rmdir|removedirs)\b"
            r"|\bshutil\.(?:rmtree|move)\b"
            r"|\bfrom[ \t]+(?:os|shutil)[ \t]+import\b[^\n]{0,200}?(?:\b(?:remove|unlink|rmdir|removedirs|rmtree|move)\b|\*)"
            r"|\.(?:unlink|rmdir)[ \t]*\((?:[ \t]*|[ \t]*missing_ok[^)\n]{0,20})\)"
        )),
        _v(JS, (
            r"\bfsp?(?:\.promises)?\.(?:unlink|rm|rmdir)(?:Sync)?\b"
            r"|(?<![\w$.])(?:unlinkSync|rmSync|rmdirSync)\b"
        )),
        _v(CC, (
            r"(?<![\w.:>])(?:_unlink|unlink|rmdir|_rmdir|DeleteFile[AW]?|RemoveDirectory[AW]?|SHFileOperation[AW]?)[ \t]*\("
            # remove() 只拦参数是字符串字面量的调用，C++ 的 std::remove 算法与自定义 remove 放行。
            r"|(?:(?<![\w.:>])|\bstd::)(?:remove|_wremove)[ \t]*\([ \t]*(?:L|u8|u|U)?\""
            r"|(?:\b\w+::)*(?:filesystem|fs)::(?:remove_all|remove)\b"
        )),
    )),
    SecurityRule("FS-03", "文件破坏", "禁止写文件、改名、改权限或创建目录。", (
        _v(PY, (
            r"\bopen[ \t]*\([^\n]{0,200}?(?:,[ \t]*|\bmode[ \t]*=[ \t]*)[rRbBuUfF]{0,2}([\"'])[rbtU]{0,3}[wax+][rbtUwax+]{0,3}\1"
            r"|\.(?:write_text|write_bytes)[ \t]*\("
            r"|\bos\.(?:rename|renames|replace|chmod|chown|lchown|mkdir|makedirs|truncate|symlink|link|utime|mkfifo|mknod)\b"
            r"|\bshutil\.(?:copy|copy2|copyfile|copytree|copyfileobj|copymode|copystat|chown|make_archive|unpack_archive)\b"
            r"|\.(?:touch|mkdir)[ \t]*\("
            r"|\bfrom[ \t]+os[ \t]+import\b[^\n]{0,200}?\b(?:rename|renames|replace|chmod|chown|mkdir|makedirs|truncate|symlink|link|utime)\b"
        )),
        _v(JS, (
            r"\bfsp?(?:\.promises)?\.(?:write\w*|append\w*|createWriteStream|copy\w*|cp\w*|rename\w*|mkdir\w*|mkdtemp\w*"
            r"|truncate\w*|chmod\w*|chown\w*|symlink\w*|link\w*|utimes\w*)"
            r"|(?<![\w$.])(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|mkdirSync|renameSync"
            r"|copyFileSync|truncateSync|writeSync)\b"
        )),
        _v(CC, (
            r"\b(?:fopen|freopen|_wfopen|_fsopen|fopen_s|_wfopen_s)[ \t]*\([^\n]{0,200}?,[ \t]*(?:L|u8|u|U)?\"[rbt]{0,3}[wa+][^\"\n]{0,12}\""
            r"|(?<![\w.:>])(?:creat|_creat|_wcreat|CreateFile[AW]?|_open|_sopen|_wopen|mkfifo|mknod)[ \t]*\("
            r"|\bopen[ \t]*\([^\n]{0,200}\bO_(?:WRONLY|RDWR|CREAT|TRUNC|APPEND)\b"
            r"|(?<![\w.:>])(?:rename|_rename|chmod|_chmod|mkdir|_mkdir|_wmkdir|symlink|chown|utime)[ \t]*\("
            r"|\b(?:std::)?(?:ofstream|wofstream|fstream|wfstream|basic_ofstream|basic_fstream)\b"
            r"|(?:\b\w+::)*(?:filesystem|fs)::(?:copy\w*|rename|create_\w+|permissions|resize_file|last_write_time)\b"
        )),
    )),
    SecurityRule("FS-04", "文件破坏", "禁止访问敏感路径、绝对路径或用 ../ 逃出工作目录。", (
        _v(ALL, (
            r"(?<![\w)\]])/(?:etc|proc|sys|dev|root|home|Users|var|usr|boot|mnt|opt)\b"
            r"|(?<![\w$])~[\\/]"
            r"|(?<![\w])\.(?:ssh|aws|kube|gnupg)\b"
            r"|\bid_(?:rsa|dsa|ecdsa|ed25519)\b|\bauthorized_keys\b|\bknown_hosts\b"
            r"|\.git-credentials|\.netrc\b|\.npmrc\b|\.pgpass\b"
            r"|(?<![\w])\.env(?:\.[\w-]+)?\b"
            r"|(?<![A-Za-z0-9_])[A-Za-z]:[\\/]"
            r"|\.\.[\\/]"
            r"|%(?:USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|SYSTEMROOT|SYSTEMDRIVE|WINDIR|PROGRAMFILES|TEMP|TMP)%"
            r"|\$\{?HOME\b"
            r"|\bSystem32\b"
        ), re.I),
    )),
    # -------------------------------------------------------------- 环境变量
    SecurityRule("ENV-01", "环境变量", "禁止读取或修改 Python 进程的环境变量（os.environ、getenv）。", (
        _v(PY, r"\b(?:environ|environb|getenv|getenvb|putenv|unsetenv)\b"),
    )),
    SecurityRule("ENV-02", "环境变量", "禁止读取 Node.js 的 process.env。", (
        _v(JS, (
            r"\bprocess[ \t]*\.[ \t]*env\b"
            r"|\bprocess[ \t]*\[[^\]\n]{0,60}[\"'`]"
            r"|\b(?:Deno|Bun)\.env\b"
            r"|\{[^}\n]{0,100}\benv\b[^}\n]{0,100}\}[ \t]*=[ \t]*process\b"
        )),
    )),
    SecurityRule("ENV-03", "环境变量", "禁止读取或修改 C/C++ 进程的环境变量（getenv、environ、envp）。", (
        _v(CC, (
            r"\b(?:getenv|_wgetenv|secure_getenv|getenv_s|putenv|_putenv|_wputenv|_putenv_s|setenv|unsetenv"
            r"|_dupenv_s|_wdupenv_s|clearenv)\b"
            r"|\b(?:Get|Set|Expand|Free)Environment(?:Variable|Strings)[AW]?\b"
            r"|\b_?environ\b|\b_wenviron\b|\benvp\b"
        )),
    )),
    # -------------------------------------------------------------- 网络外联
    SecurityRule("NET-01", "网络外联", "禁止在 Python 里导入或调用网络库（socket、requests、urllib.request 等）。", (
        _v(PY, (
            rf"\b(?:import|from)[ \t]+[\w., \t]{{0,120}}?\b(?:{_PY_NET_MODULES})\b"
            r"|\burllib[ \t]*\.[ \t]*(?:request|urlopen)\b|\burlopen\b|\burlretrieve\b"
            r"|\bfrom[ \t]+urllib[ \t]+import\b[^\n]{0,100}?\brequest\b"
            r"|\bfrom[ \t]+http[ \t]+import\b[^\n]{0,100}?\b(?:client|server)\b"
            r"|\basyncio\.(?:open_connection|start_server|create_connection|create_server|open_unix_connection)\b"
        )),
    )),
    SecurityRule("NET-02", "网络外联", "禁止在 JavaScript 里使用网络模块与 API（http、net、fetch、WebSocket 等）。", (
        _v(JS, (
            r"(?:\brequire|\bimport)\b[^\n]{0,120}?[\"'`](?:node:)?(?:https?|http2|net|dgram|tls|dns(?:/promises)?)[\"'`]"
            r"|(?<![\w$.])fetch[ \t]*\(|\b(?:globalThis|window|self|global)\.fetch\b"
            r"|\b(?:XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b"
        )),
    )),
    SecurityRule("NET-03", "网络外联", "禁止在 C/C++ 里包含网络头文件或调用网络函数。", (
        _v(CC, (
            r"#[ \t]*include[ \t]*[<\"](?:sys/socket|sys/un|winsock2?|ws2tcpip|netinet/|arpa/inet|netdb|net/|curl/"
            r"|wininet|winhttp|urlmon|asio|boost/asio|httplib|cpr/|zmq|libwebsockets|mosquitto|uv\.h)"
        ), re.I),
        _v(CC, (
            r"\b(?:WSAStartup|WSASocket[AW]?|getaddrinfo|GetAddrInfo[AW]?|gethostbyname|gethostbyaddr|getnameinfo"
            r"|inet_addr|inet_pton|inet_ntoa|InternetOpen[AW]?|InternetOpenUrl[AW]?|InternetConnect[AW]?"
            r"|InternetReadFile|URLDownloadToFile[AW]?|URLOpenStream[AW]?|WinHttpOpen|WinHttpConnect"
            r"|curl_easy_init|curl_global_init)\b"
            r"|(?<![\w.>])socket[ \t]*\(|\bboost::asio\b|\basio::"
        )),
    )),
    SecurityRule("NET-04", "网络外联", "禁止出现命令行联网工具（curl、wget、Invoke-WebRequest 等）。", (
        _v(ALL, (
            r"(?<![\w.-])(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|ncat|netcat|bitsadmin)(?![\w-])"
            r"|\bcertutil[ \t]+-urlcache"
        ), re.I),
    )),
    # ---------------------------------------------------------- 进程与系统
    SecurityRule("PROC-01", "进程与系统", "禁止在 Python 里启动子进程、调用系统命令或加载原生库。", (
        _v(PY, (
            r"\bsubprocess\b|\bProcessPoolExecutor\b"
            rf"|\bos\.(?:{_PY_OS_PROC})\b"
            rf"|\bfrom[ \t]+(?:os|posix|nt)[ \t]+import\b[^\n]{{0,200}}?(?:\b(?:{_PY_OS_PROC})\b|\*)"
            r"|\b(?:import|from)[ \t]+[\w., \t]{0,120}?\b(?:ctypes|cffi|pty|multiprocessing|importlib|pexpect|plumbum|posix|nt|_winapi|_posixsubprocess)\b"
            r"|\.(?:system|popen)[ \t]*\("
        )),
    )),
    SecurityRule("PROC-02", "进程与系统", "禁止在 JavaScript 里使用 child_process、worker_threads、cluster 或改动进程状态。", (
        _v(JS, (
            r"\bchild_process\b|\bworker_threads\b"
            r"|(?:\brequire|\bimport)\b[^\n]{0,120}?[\"'`](?:node:)?cluster[\"'`]"
            r"|\bprocess[ \t]*\.[ \t]*(?:binding|_linkedBinding|dlopen|kill|chdir|abort|reallyExit|setuid|setgid|seteuid|setegid|umask)\b"
            r"|(?<![\w$.])(?:execSync|spawnSync|execFileSync|execFile)[ \t]*\("
        )),
    )),
    SecurityRule("PROC-03", "进程与系统", "禁止在 C/C++ 里调用 system、fork、exec 系列、CreateProcess 或动态加载库。", (
        _v(CC, (
            r"(?<![\w.>])(?:std::|::)?(?:system|popen|_popen|_wpopen|_wsystem|fork|vfork|WinExec|dlopen|ptrace"
            r"|_?exec(?:l|le|lp|lpe|v|ve|vp|vpe)|_?spawn(?:l|le|lp|lpe|v|ve|vp|vpe)|posix_spawnp?"
            r"|CreateProcess(?:A|W|AsUserA|AsUserW|WithLogonW)?|ShellExecute(?:A|W|ExA|ExW)?"
            r"|LoadLibrary(?:A|W|ExA|ExW)?)[ \t]*\("
        )),
    )),
    SecurityRule("PROC-04", "进程与系统", "禁止 fork 炸弹与批处理自我复制。", (
        _v(ALL, (
            r":\(\)[ \t]*\{"
            r"|%0[ \t]*\|[ \t]*%0|\bstart[ \t]+%0\b"
            r"|\bwhile[ \t]*\(?[ \t]*(?:1|true)[ \t]*\)?[ \t:{]*(?:os\.)?fork[ \t]*\("
            r"|\bfor[ \t]*\([ \t]*;[ \t]*;[ \t]*\)[ \t{]*fork[ \t]*\("
        ), re.I),
    )),
    # -------------------------------------------------------------- 动态代码
    SecurityRule("DYN-01", "动态代码", "禁止 Python 的 exec / eval / compile / __import__ 与内省逃逸。", (
        _v(PY, (
            r"(?<![\w.])(?:exec|compile)[ \t]*\("
            # eval(input(...)) 是常见的入门写法，刻意放行。
            r"|(?<![\w.])eval[ \t]*\((?![ \t]*input[ \t]*\()"
            r"|\b__(?:import|builtins|subclasses|globals|loader|spec|code|bases|mro)__\b"
            r"|(?<![\w.])breakpoint[ \t]*\("
            r"|\b(?:import|from)[ \t]+(?:runpy|pdb|code|codeop|bdb)\b"
        )),
    )),
    SecurityRule("DYN-02", "动态代码", "禁止 JavaScript 的 eval、Function 构造器、动态 import 与 vm 模块。", (
        _v(JS, (
            r"(?<![\w$.])eval[ \t]*\(|\bnew[ \t]+Function\b|(?<![\w$.])Function[ \t]*\("
            r"|(?<![\w$.])import[ \t]*\("
            r"|(?:\brequire|\bimport)\b[^\n]{0,120}?[\"'`](?:node:)?(?:vm|module|v8|repl|inspector|wasi)[\"'`]"
            r"|\bconstructor[ \t]*\.[ \t]*constructor\b|\[[ \t]*[\"'`]constructor[\"'`][ \t]*\]"
            r"|\b(?:setTimeout|setInterval|setImmediate)[ \t]*\([ \t]*[\"'`]"
        )),
    )),
)


# --------------------------------------------------------------------- 预处理

_JS_ESCAPE = re.compile(r"\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})")
_PY_FSTRING_PREFIX = re.compile(r"""(?<![\w])[fFrR]{1,2}["']""")
_REGEX_PRECEDING_KEYWORDS = {
    "return", "typeof", "case", "do", "else", "in", "of", "void", "delete", "throw", "new", "yield", "await",
}
_REGEX_ALLOWED_AFTER = set("(,=:[!&|?{};+-*%<>~^")


def _clean_line(line: str) -> str:
    line = unicodedata.normalize("NFKC", line)
    chars: list[str] = []
    for char in line:
        if unicodedata.category(char) == "Cf":
            continue  # 零宽字符等不可见格式字符
        if (ord(char) < 32 and char != "\t") or ord(char) == 127:
            chars.append(" ")
        else:
            chars.append(char)
    return "".join(chars)


def _blank(segment: str) -> str:
    return re.sub(r"[^\n]", " ", segment)


def _strip_python(text: str) -> str | None:
    """剥离 # 注释，保持换行数不变。解析有歧义时返回 None，让调用方扫描原文。"""
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        char = text[i]
        if char == "#":
            start = text.rfind("\n", 0, i) + 1
            if _PY_FSTRING_PREFIX.search(text[start:i]):
                return None  # 3.12 起 f-string 里可以嵌套同种引号，# 不一定是注释
            end = text.find("\n", i)
            end = n if end == -1 else end
            out.append(" " * (end - i))
            i = end
        elif char in "'\"":
            quote = char * 3 if text.startswith(char * 3, i) else char
            j = i + len(quote)
            while True:
                if j >= n:
                    return None
                if text[j] == "\\":
                    j += 2
                    continue
                if text.startswith(quote, j):
                    j += len(quote)
                    break
                if len(quote) == 1 and text[j] == "\n":
                    return None
                j += 1
            out.append(text[i:j])
            i = j
        else:
            out.append(char)
            i += 1
    return "".join(out)


def _strip_c_like(text: str, language: str) -> str | None:
    js = language == "javascript"
    if js and "${" in text:
        return None  # 模板字符串可以嵌套反引号，不冒险剥离
    if language == "cpp" and re.search(r'\bR"', text):
        return None  # 原始字符串
    out: list[str] = []
    i, n = 0, len(text)
    last = ""
    while i < n:
        char = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if char == "/" and nxt == "/":
            end = text.find("\n", i)
            end = n if end == -1 else end
            out.append(" " * (end - i))
            i = end
            continue
        if char == "/" and nxt == "*":
            end = text.find("*/", i + 2)
            if end == -1:
                return None
            out.append(_blank(text[i:end + 2]))
            i = end + 2
            continue
        if char in "'\"" or (js and char == "`"):
            j = i + 1
            while True:
                if j >= n:
                    return None
                current = text[j]
                if current == "\\":
                    j += 2
                    continue
                if current == char:
                    j += 1
                    break
                if current == "\n" and char != "`":
                    return None
                j += 1
            out.append(text[i:j])
            last = char
            i = j
            continue
        if js and char == "/":
            previous_word = re.search(r"([A-Za-z_$][\w$]*)[ \t\n]*$", text[max(0, i - 20):i])
            regex_allowed = (
                last == "" or last in _REGEX_ALLOWED_AFTER
                or (previous_word is not None and previous_word.group(1) in _REGEX_PRECEDING_KEYWORDS)
            )
            if regex_allowed:
                j = i + 1
                in_class = False
                while True:
                    if j >= n or text[j] == "\n":
                        return None
                    current = text[j]
                    if current == "\\":
                        j += 2
                        continue
                    if current == "[":
                        in_class = True
                    elif current == "]":
                        in_class = False
                    elif current == "/" and not in_class:
                        j += 1
                        break
                    j += 1
                while j < n and text[j].isalpha():
                    j += 1
                out.append(text[i:j])
                last = "x"
                i = j
                continue
        out.append(char)
        if not char.isspace():
            last = char
        i += 1
    return "".join(out)


def _decode_js_escape(match: re.Match[str]) -> str:
    code = int(next(group for group in match.groups() if group is not None), 16)
    if code > 0x10FFFF or code < 32 or code == 127:
        return " "
    return chr(code)


def _prepare(code: str, language: str | None) -> tuple[str, list[int], list[str]]:
    raw = code.replace("\r\n", "\n").replace("\r", "\n")
    original_lines = raw.split("\n")
    text = "\n".join(_clean_line(line) for line in original_lines)
    stripped: str | None = None
    if language == "python":
        stripped = _strip_python(text)
    elif language in ("javascript", "c", "cpp"):
        stripped = _strip_c_like(text, language)
    if stripped is not None:
        text = stripped
    if language in (None, "javascript"):
        text = _JS_ESCAPE.sub(_decode_js_escape, text)
    merge = language != "javascript"  # JS 没有反斜杠续行
    parts: list[str] = []
    starts: list[int] = []
    position = 0
    for line in text.split("\n"):
        starts.append(position)
        if merge and line.endswith("\\"):
            piece = line[:-1]
            parts.append(piece)
            position += len(piece)
        else:
            parts.append(line + "\n")
            position += len(line) + 1
    return "".join(parts), starts, original_lines


def check_security_blacklist(code: str, language: str | None = None) -> list[BlockedRule]:
    """返回全部命中的规则（每条规则取首个命中行）。language 为 None 时应用全部规则。"""
    lang = normalize_language(language)
    text, starts, original_lines = _prepare(code, lang)
    hits: list[BlockedRule] = []
    for rule in DEFAULT_SECURITY_BLACKLIST:
        earliest: int | None = None
        for variant in rule.variants:
            if lang is not None and lang not in variant.languages:
                continue
            match = variant.pattern.search(text)
            if match and (earliest is None or match.start() < earliest):
                earliest = match.start()
        if earliest is None:
            continue
        line = max(1, bisect.bisect_right(starts, earliest))
        excerpt = original_lines[min(line, len(original_lines)) - 1].strip()[:MAX_EXCERPT]
        hits.append(BlockedRule(
            rule_id=rule.rule_id, category=rule.category, description=rule.description,
            line=line, excerpt=excerpt,
        ))
    hits.sort(key=lambda item: (item.line, item.rule_id))
    return hits
