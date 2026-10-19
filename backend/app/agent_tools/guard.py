import re
from pathlib import Path


# Matches only where a shell command starts: line start or after ; & | ( or $(.
COMMAND_START = r"(?:^|[;&|(]|\$\()\s*"

# LobeHub-style mandatory baseline: 4 + 4 + 3 + 3 + 3 rules.
# This is deliberately independent of workspace, approval and agent configuration.
DEFAULT_SECURITY_BLACKLIST: tuple[str, ...] = (
    # Destructive removal / disk destruction (4).
    r"\brm(?:\.exe)?\s+(?=[^;\n|&]*(?<!\S)(?:-[a-z]*r[a-z]*|--recursive)\b)(?=[^;\n|&]*(?<!\S)(?:-[a-z]*f[a-z]*|--force)\b)[^;\n|&]+",
    # `format` only as a command, so `npm run format` and `--format=` stay allowed.
    COMMAND_START + r"format(?:\.com|\.exe)?(?=\s|$)"
    r"|(?<![\w.-])(?:mkfs(?:\.[\w-]+)?|format-volume|clear-disk|diskpart)(?=\s|$)",
    r"\bdd\b[^;\n|&]*\bof\s*=\s*/dev/(?:sd|hd|vd|nvme|mmcblk|disk)\w*",
    r"(?:\b(?:wipefs|shred)\b[^;\n|&]*|>{1,2}\s*)/dev/(?:sd|hd|vd|nvme|mmcblk|disk)\w*|\bremove-item\s+(?=[^;\n|&]*-recurse\b)(?=[^;\n|&]*-force\b)[^;\n|&]+"
    r"|\b(?:rd|rmdir)\s+/s\s+/q\s+[a-z]:[\\/]|\bdel\s+/[fsq][^;\n|&]*[a-z]:[\\/]",
    # Environment and sensitive credential files (4).
    r"(?<![\w.-])\.env(?:\.[\w.-]+)?(?![\w.-])"
    r"|\bprintenv\b|\$env:|\b(?:get-childitem|gci|dir|ls)\s+env:|/proc/(?:self|\d+)/environ",
    r"(?<![\w.-])\.?(?:credentials?|secrets?)(?:\.[\w.-]+)?(?![\w.-])",
    r"/etc/(?:passwd|shadow|gshadow|master\.passwd|security/opasswd)(?![\w.-])",
    r"(?<![\w.-])\.(?:netrc|npmrc|pypirc|git-credentials)(?![\w.-])",
    # SSH directories and private key access (3).
    r"(?<![\w.-])\.ssh(?![\w.-])",
    r"(?<![\w.-])id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?:\.pub)?(?![\w.-])",
    r"(?<![\w.-])(?:private[_-]?key(?:\.[\w.-]+)?|[\w.-]+\.(?:pem|key|p12|pfx))(?![\w.-])",
    # Cloud / container credentials (3).
    r"(?<![\w.-])\.aws(?![\w.-])",
    r"(?<![\w.-])\.kube(?![\w.-])|(?<![\w.-])kubeconfig(?:\.[\w.-]+)?(?![\w.-])",
    r"(?<![\w.-])\.docker(?![\w.-])|(?<![\w.-])docker[_-]auth(?:\.[\w.-]+)?(?![\w.-])",
    # SUID / privilege escalation / fork bomb (3).
    r"\bchmod\b[^;\n|&]*(?<!\S)(?:[ugoa]*\+s|[2467][0-7]{3})(?!\S)",
    COMMAND_START + r"(?:sudo|su|doas|pkexec)(?![\w.-])",
    r":\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:|%0\s*\|\s*%0",
)

_SECURITY_PATTERNS = tuple(re.compile(rule, re.IGNORECASE | re.MULTILINE) for rule in DEFAULT_SECURITY_BLACKLIST)
_PRIVATE_KEY = re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----")


class ToolError(Exception):
    pass


def check_security_blacklist(command_or_path: str) -> str | None:
    """Return a safe diagnostic, never echoing the potentially secret input."""
    # Windows separators and shell quoting must not disguise protected paths.
    normalized = command_or_path.replace("\\", "/")
    unquoted = re.sub(r"['\"`]", "", normalized)
    for index, pattern in enumerate(_SECURITY_PATTERNS, 1):
        if pattern.search(normalized) or pattern.search(unquoted):
            return f"命中不可绕过的安全黑名单规则 {index}。"
    return None


def enforce_security_blacklist(command_or_path: str) -> None:
    reason = check_security_blacklist(command_or_path)
    if reason:
        raise ToolError(f"安全防线拦截：{reason}")


def check_content_security_blacklist(content: str) -> str | None:
    """Scan text about to be written; private key material must never land in the workspace."""
    if isinstance(content, str) and _PRIVATE_KEY.search(content):
        return "写入内容包含私钥，命中不可绕过的内容安全规则。"
    return None


def enforce_content_security_blacklist(content: str) -> None:
    reason = check_content_security_blacklist(content)
    if reason:
        raise ToolError(f"安全防线拦截：{reason}")


def resolve_inside(root: Path | None, raw: str) -> Path:
    if isinstance(raw, str):
        enforce_security_blacklist(raw)
    if root is None or not root.is_dir():
        raise ToolError("还没有工作区。请先在设置里选择一个文件夹。")
    if not isinstance(raw, str) or not raw.strip():
        raise ToolError("缺少路径。")
    base = root.resolve()
    candidate = Path(raw.strip())
    if not candidate.is_absolute():
        candidate = base / candidate
    try:
        path = candidate.resolve()
    except OSError as exc:
        raise ToolError(f"路径无效：{exc.strerror or exc}") from None
    # Check the resolved target too, so a benign-looking symlink is not an escape.
    enforce_security_blacklist(str(path))
    if path != base and base not in path.parents:
        raise ToolError("路径超出工作区。")
    return path
