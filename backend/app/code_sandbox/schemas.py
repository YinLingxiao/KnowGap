"""POST /api/sandbox/run 的请求与响应契约。

响应是任务契约 `{ok, stdout, stderr, exit_code, test_results}` 的超集，
额外字段（status、message、blocked、compile、diagnostics 等）供前端展示细节。
"""

from typing import Literal

from pydantic import AliasChoices, BaseModel, Field, field_validator

Language = Literal["python", "javascript", "c", "cpp"]

MAX_CODE_CHARS = 20_000
MAX_TEST_CASES = 10
MAX_IO_CHARS = 10_000

# 模型常把语言写成这些别名，统一归一化，避免因拼写差异让整次运行失败。
_ALIASES = {
    "py": "python", "python3": "python",
    "c++": "cpp", "cplusplus": "cpp",
    "js": "javascript", "node": "javascript", "nodejs": "javascript",
}


def normalize_language(value: object) -> str | None:
    """返回规范语言名；无法识别时原样（小写）返回，None 表示未指定。"""
    if value is None:
        return None
    if not isinstance(value, str):
        return None
    key = value.strip().lower()
    return _ALIASES.get(key, key)


class SandboxCase(BaseModel):
    name: str | None = Field(default=None, max_length=60)
    input: str = Field(default="", max_length=MAX_IO_CHARS)
    # 为 None 表示只运行、不比对输出。同时接受旧字段名 expected_output。
    expected: str | None = Field(
        default=None, max_length=MAX_IO_CHARS,
        validation_alias=AliasChoices("expected", "expected_output"),
    )


class RunRequest(BaseModel):
    language: Language
    code: str = Field(min_length=1, max_length=MAX_CODE_CHARS)
    stdin: str = Field(default="", max_length=MAX_IO_CHARS)
    test_cases: list[SandboxCase] = Field(default_factory=list, max_length=MAX_TEST_CASES)

    @field_validator("language", mode="before")
    @classmethod
    def _normalize_language(cls, value):
        return normalize_language(value) if isinstance(value, str) else value

    @field_validator("code")
    @classmethod
    def _clean_code(cls, value: str) -> str:
        if "\x00" in value:
            raise ValueError("代码里不能包含 NUL 字符。")
        return value.replace("\r\n", "\n").replace("\r", "\n")


class Diagnostic(BaseModel):
    line: int | None = None  # 链接错误等场景没有行号
    column: int | None = None
    severity: Literal["error", "warning"]
    message: str


class BlockedRule(BaseModel):
    rule_id: str
    category: str
    description: str
    line: int
    excerpt: str  # 命中的那一行代码（已截断），方便学生和 AI 定位


class CompileResult(BaseModel):
    """编译（C/C++）或语法检查（Python/JavaScript）阶段的真实输出。"""

    ok: bool
    stdout: str
    stderr: str
    diagnostics: list[Diagnostic]
    duration_ms: int


CaseStatus = Literal["passed", "failed", "ok", "runtime_error", "timeout", "output_limit", "skipped"]


class CaseResult(BaseModel):
    index: int
    name: str
    input: str
    expected: str | None
    status: CaseStatus
    passed: bool | None  # 没有 expected 时为 None
    stdout: str
    stderr: str
    exit_code: int | None
    exit_note: str | None  # 对常见崩溃退出码的中文解释
    duration_ms: int
    truncated: bool
    timed_out: bool
    diagnostics: list[Diagnostic]


RunStatus = Literal["blocked", "compile_error", "timeout", "runtime_error", "failed", "passed", "ok"]


class RunResponse(BaseModel):
    ok: bool  # 仅 status 为 ok / passed 时为 True
    status: RunStatus
    message: str
    language: Language
    stdout: str
    stderr: str
    exit_code: int  # 被拦截或未执行时为 -1
    blocked: list[BlockedRule]
    compile: CompileResult | None
    test_results: list[CaseResult]
    passed: int  # 带 expected 的用例中通过的数量
    total: int  # 带 expected 的用例总数
    diagnostics: list[Diagnostic]  # 供编辑器标红：编译错误，或首个运行时错误
    time_limit_seconds: float
