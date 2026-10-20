"""代码沙盒：17 条黑名单、真实编译 / 运行、路由保护、微件协议。

需要 gcc / g++ / node 的用例在缺少工具时自动跳过；Windows 专属用例只在 Windows 上跑。
"""

import glob
import json
import os
import re
import shutil
import sys
import tempfile
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.agent_tools import guard
from app.chat.skills.thread_skills import WIDGET_SCHEMA_GUIDE
from app.code_sandbox import blacklist, router as router_module, runner
from app.code_sandbox.blacklist import DEFAULT_SECURITY_BLACKLIST, check_security_blacklist
from app.code_sandbox.router import sandbox_router
from app.code_sandbox.runner import run_sandbox
from app.code_sandbox.schemas import RunRequest

HAS_GCC = shutil.which("gcc") is not None
HAS_GPP = shutil.which("g++") is not None
HAS_NODE = shutil.which("node") is not None
needs_gcc = pytest.mark.skipif(not HAS_GCC, reason="没有 gcc")
needs_gpp = pytest.mark.skipif(not HAS_GPP, reason="没有 g++")
needs_node = pytest.mark.skipif(not HAS_NODE, reason="没有 node")
windows_only = pytest.mark.skipif(os.name != "nt", reason="Windows Job Object 专属")


def run(language: str, code: str, **extra):
    return run_sandbox(RunRequest(language=language, code=code, **extra))


def sandbox_dirs() -> set[str]:
    return set(glob.glob(os.path.join(tempfile.gettempdir(), "knowgap-sbx-*")))


# ------------------------------------------------------------------ 黑名单

# 每条规则至少一个命中样例：规则 id -> (语言, 代码)
RULE_SAMPLES = {
    "FS-01": ("python", "cmd = 'rm -rf build'"),
    "FS-02": ("python", "import os\nos.remove('a.txt')"),
    "FS-03": ("python", "f = open('out.txt', 'w')"),
    "FS-04": ("python", "data = open('/etc/passwd').read()"),
    "ENV-01": ("python", "import os\nprint(os.environ['HOME'])"),
    "ENV-02": ("javascript", "console.log(process.env.HOME)"),
    "ENV-03": ("c", 'char *p = getenv("HOME");'),
    "NET-01": ("python", "import socket"),
    "NET-02": ("javascript", "fetch('http://example.com')"),
    "NET-03": ("c", "#include <sys/socket.h>"),
    "NET-04": ("python", "cmd = 'curl http://example.com'"),
    "PROC-01": ("python", "import subprocess\nsubprocess.run(['ls'])"),
    "PROC-02": ("javascript", "const cp = require('child_process');"),
    "PROC-03": ("c", 'int main(){ system("pause"); }'),
    "PROC-04": ("python", 'bomb = ":(){ :|:& };:"'),
    "DYN-01": ("python", "exec('print(1)')"),
    "DYN-02": ("javascript", "eval('1+1')"),
}

# 常见的合法教学代码，不应被拦截。
BENIGN = [
    ("python", "print('hello')"),
    ("python", "while True:\n    n = int(input())\n    if n == 0:\n        break"),
    ("python", "xs = [1, 2, 3]\nxs.remove(2)\nprint(xs)"),
    ("python", "n = eval(input())\nprint(n * 2)"),
    ("python", "import math, sys, random\nfrom collections import deque\nprint(sys.stdin.read())"),
    ("python", "with open('data.txt') as f:\n    print(f.read())"),
    ("python", "# os.system('ls') 只是注释\nprint(1)"),
    ("python", "from urllib.parse import quote\nprint(quote('a b'))"),
    ("javascript", "console.log('hello'); process.exit(0)"),
    ("javascript", "const lines = require('fs').readFileSync(0, 'utf8').split('\\n');"),
    ("javascript", "const rl = require('readline').createInterface({ input: process.stdin });"),
    ("javascript", "// fetch('x') 只是注释\nconsole.log(1)"),
    ("c", '#include <stdio.h>\nint main(void){ printf("hello\\n"); return 0; }'),
    ("c", "#include <stdlib.h>\nint main(void){ int *p = malloc(4); free(p); return 0; }"),
    ("cpp", "#include <algorithm>\n#include <vector>\nint main(){ std::vector<int> v{1,2,1};"
            " v.erase(std::remove(v.begin(), v.end(), 1), v.end()); }"),
    ("cpp", "#include <iostream>\nint main(){ std::cout << \"hi\\n\"; }"),
]


def test_exactly_seventeen_unique_rules():
    assert len(DEFAULT_SECURITY_BLACKLIST) == 17
    ids = [rule.rule_id for rule in DEFAULT_SECURITY_BLACKLIST]
    assert len(set(ids)) == 17
    assert set(ids) == set(RULE_SAMPLES)


@pytest.mark.parametrize("rule_id", sorted(RULE_SAMPLES))
def test_every_rule_blocks_its_sample(rule_id):
    language, code = RULE_SAMPLES[rule_id]
    hits = check_security_blacklist(code, language)
    assert rule_id in {hit.rule_id for hit in hits}, hits


@pytest.mark.parametrize("language,code", BENIGN)
def test_benign_code_is_not_blocked(language, code):
    assert check_security_blacklist(code, language) == []


def test_hit_reports_line_and_excerpt():
    hits = check_security_blacklist("print(1)\nimport socket\nprint(2)", "python")
    assert [(hit.rule_id, hit.line, hit.excerpt) for hit in hits] == [("NET-01", 2, "import socket")]


def test_language_none_applies_all_rules():
    ids = {hit.rule_id for hit in check_security_blacklist("process.env.A")}
    assert "ENV-02" in ids


def test_variants_are_language_scoped():
    # C 的 remove("x") 要拦，Python 的 list.remove 不拦。
    assert any(hit.rule_id == "FS-02" for hit in check_security_blacklist('remove("a.txt");', "c"))
    assert check_security_blacklist("xs.remove(1)", "python") == []


def test_obfuscation_is_normalized():
    # 零宽字符、全角字符、JS 的 \u 转义、续行都不能绕过。
    assert check_security_blacklist("import so\u200bcket", "python")
    assert check_security_blacklist("ｉｍｐｏｒｔ socket", "python")
    assert check_security_blacklist("e\\u0076al('1')", "javascript")
    assert check_security_blacklist("sy\\\nstem(\"ls\");", "c")


def test_comments_are_ignored_but_code_after_them_is_not():
    assert check_security_blacklist("x = 1  # import socket", "python") == []
    assert check_security_blacklist("/* system(\"x\") */ int a;", "c") == []
    assert check_security_blacklist("/* ok */ system(\"x\");", "c")


def test_adversarial_long_lines_scan_fast():
    samples = [
        ("python", "a" * 20_000), ("python", "os." * 6_000), ("python", "open(" * 4_000),
        ("cpp", "(" * 20_000), ("javascript", "process[" * 3_000), ("c", "fopen(" * 3_000),
    ]
    started = time.perf_counter()
    for language, code in samples:
        check_security_blacklist(code, language)
    assert time.perf_counter() - started < 1.0


def test_guard_reexports_the_same_function():
    assert guard.check_security_blacklist is blacklist.check_security_blacklist
    assert guard.DEFAULT_SECURITY_BLACKLIST is blacklist.DEFAULT_SECURITY_BLACKLIST
    assert runner.check_security_blacklist is blacklist.check_security_blacklist


# ------------------------------------------------------------------ 契约

def test_request_normalizes_language_and_aliases():
    request = RunRequest.model_validate({
        "language": "C++", "code": "int main(){}\r\n",
        "test_cases": [{"input": "1", "expected_output": "2"}, {"input": "3", "expected": "4"}],
    })
    assert request.language == "cpp"
    assert request.code == "int main(){}\n"
    assert [case.expected for case in request.test_cases] == ["2", "4"]
    assert RunRequest(language="js", code="1").language == "javascript"


def test_request_rejects_bad_input():
    with pytest.raises(ValueError):
        RunRequest(language="ruby", code="puts 1")
    with pytest.raises(ValueError):
        RunRequest(language="python", code="print(1)\x00")
    with pytest.raises(ValueError):
        RunRequest(language="python", code="x" * 20_001)
    with pytest.raises(ValueError):
        RunRequest(language="python", code="1", test_cases=[{"input": ""}] * 11)


# ------------------------------------------------------------------ 拦截不起进程

def test_blocked_code_never_spawns_a_process(monkeypatch):
    def boom(*args, **kwargs):
        raise AssertionError("被拦截的代码不应该启动任何进程")

    monkeypatch.setattr(runner.subprocess, "Popen", boom)
    response = run("python", "import os\nos.system('dir')")
    assert response.status == "blocked" and not response.ok
    assert response.exit_code == -1
    assert response.blocked[0].rule_id == "PROC-01" and response.blocked[0].line == 2
    assert response.diagnostics[0].line == 2


# ------------------------------------------------------------------ Python

def test_python_stdin_and_expected_comparison():
    before = sandbox_dirs()
    response = run(
        "python", "n = int(input())\nprint(n * 2)",
        test_cases=[{"input": "3\n", "expected": "6"}, {"input": "4\n", "expected": "9"}],
    )
    assert response.status == "failed" and not response.ok
    assert (response.passed, response.total) == (1, 2)
    assert [case.passed for case in response.test_results] == [True, False]
    assert response.test_results[1].stdout.strip() == "8"
    assert response.stdout.strip() == "8"  # 顶层输出取第一个未通过的用例
    assert sandbox_dirs() == before


def test_python_all_cases_pass_and_plain_run():
    passed = run("python", "print(int(input()) + 1)", test_cases=[{"input": "1", "expected": "2\n"}])
    assert passed.status == "passed" and passed.ok and passed.exit_code == 0
    plain = run("python", "import sys\nprint(sys.stdin.read().upper())", stdin="abc")
    assert plain.status == "ok" and plain.ok and plain.stdout.strip() == "ABC"
    assert plain.total == 0


def test_python_syntax_error_has_line_number():
    response = run("python", "x = 1\nprint('a'\ny = 2")
    assert response.status == "compile_error" and response.exit_code == -1
    assert response.compile is not None and not response.compile.ok
    assert response.diagnostics and response.diagnostics[0].line in (2, 3)
    assert response.test_results == []


def test_python_runtime_error_reports_line():
    response = run("python", "x = 1\nprint(1 / 0)")
    assert response.status == "runtime_error"
    assert "ZeroDivisionError" in response.stderr
    assert response.diagnostics[0].line == 2
    assert response.exit_code == 1


def test_python_infinite_loop_times_out_quickly():
    started = time.perf_counter()
    response = run("python", "while True:\n    pass")
    elapsed = time.perf_counter() - started
    assert response.status == "timeout" and response.test_results[0].timed_out
    assert 2.5 <= elapsed < 8
    assert response.time_limit_seconds == 3.0


def test_python_output_flood_is_cut_off():
    response = run("python", "while True:\n    print('x' * 1000)")
    case = response.test_results[0]
    assert case.status == "output_limit" and case.truncated
    assert len(response.stdout) < 80_000
    assert response.status == "runtime_error"


def test_python_runs_with_a_clean_environment(monkeypatch):
    monkeypatch.setenv("KNOWGAP_SECRET_FOR_TEST", "s3cret")
    response = run("python", "import sys\nprint(sorted(sys.modules.keys() & {'fastapi', 'pydantic'}))")
    assert response.status == "ok"
    assert response.stdout.strip() == "[]"  # 没有 import 到 venv 里的包


def test_output_never_leaks_the_sandbox_path():
    before = sandbox_dirs()
    response = run("python", "import os\nprint(os.getcwd())\nprint(__file__)\nraise SystemExit(3)")
    assert "knowgap-sbx-" not in response.stdout + response.stderr
    assert response.exit_code == 3
    assert sandbox_dirs() == before


def test_compile_error_output_has_no_sandbox_path():
    response = run("python", "def f(:\n    pass")
    assert "knowgap-sbx-" not in (response.compile.stderr if response.compile else "")


def test_skipped_cases_when_deadline_is_exhausted(monkeypatch):
    monkeypatch.setattr(runner, "TOTAL_DEADLINE_SECONDS", 0.0)
    response = run("python", "print(1)", test_cases=[{"input": "", "expected": "1"}])
    assert response.test_results[0].status == "skipped"
    assert response.status == "timeout" and not response.ok


# ------------------------------------------------------------------ C / C++

C_ECHO = r'''#include <stdio.h>
int main(void) {
    int a;
    scanf("%d", &a);
    printf("%d\n", a * a);
    return 0;
}
'''


@needs_gcc
def test_c_compiles_runs_and_compares():
    response = run("c", C_ECHO, test_cases=[{"input": "3", "expected": "9"}, {"input": "4", "expected": "16"}])
    assert response.status == "passed" and (response.passed, response.total) == (2, 2)


@needs_gcc
def test_c_compile_error_has_line_and_column():
    response = run("c", '#include <stdio.h>\nint main(void){\n    printf("hi")\n    return 0;\n}\n')
    assert response.status == "compile_error"
    errors = [d for d in response.diagnostics if d.severity == "error"]
    assert errors and errors[0].line is not None and errors[0].column is not None
    assert "main.c" in response.compile.stderr and "knowgap-sbx-" not in response.compile.stderr


@needs_gcc
def test_c_link_error_has_no_line_number():
    response = run("c", "int missing(void);\nint main(void){ return missing(); }\n")
    assert response.status == "compile_error"
    assert any(d.line is None and "undefined reference" in d.message for d in response.diagnostics)


@needs_gcc
def test_c_warnings_do_not_fail_the_build():
    response = run("c", '#include <stdio.h>\nint main(void){ int unused; printf("ok\\n"); return 0; }\n')
    assert response.status == "ok"
    assert any(d.severity == "warning" for d in response.compile.diagnostics)


@needs_gpp
def test_cpp_runs():
    response = run("cpp", '#include <iostream>\nint main(){ std::cout << "hi\\n"; }\n')
    assert response.status == "ok" and response.stdout == "hi\n"


@needs_gcc
@windows_only
def test_c_crash_gets_a_chinese_exit_note():
    response = run("c", "int main(void){ int *p = 0; *p = 1; return 0; }\n")
    assert response.status == "runtime_error"
    assert response.test_results[0].exit_note and "非法内存" in response.test_results[0].exit_note


# ------------------------------------------------------------------ JavaScript

@needs_node
def test_js_reads_stdin_three_ways():
    codes = [
        "const s = require('fs').readFileSync(0, 'utf8').trim(); console.log(s.toUpperCase());",
        "const rl = require('readline').createInterface({ input: process.stdin });\n"
        "rl.on('line', (l) => console.log(l.toUpperCase()));",
        "let d = ''; process.stdin.on('data', (c) => d += c);\n"
        "process.stdin.on('end', () => console.log(d.trim().toUpperCase()));",
    ]
    for code in codes:
        response = run("javascript", code, stdin="abc\n")
        assert response.status == "ok" and response.stdout.strip() == "ABC", (code, response.stderr)


@needs_node
def test_js_syntax_error_and_runtime_error():
    syntax = run("javascript", "let = ;")
    assert syntax.status == "compile_error" and syntax.diagnostics[0].line == 1
    runtime = run("javascript", "function f(){ throw new Error('boom') }\nf()")
    assert runtime.status == "runtime_error" and "boom" in runtime.stderr
    assert runtime.diagnostics and runtime.diagnostics[0].line == 1
    assert "node:internal" not in runtime.stderr


# ------------------------------------------------------------------ Job Object

@windows_only
def test_job_object_forbids_spawning_children():
    code = (
        "import subprocess, sys\n"
        "try:\n"
        "    subprocess.run([sys.executable, '-c', 'pass'], check=True)\n"
        "    print('SPAWNED')\n"
        "except BaseException as e:\n"
        "    print('BLOCKED', type(e).__name__)\n"
    )
    result = runner._run_process(
        [runner._python_executable(), "-I", "-c", code], cwd=sandbox_cwd(), env=runner._sandbox_env(sandbox_cwd()),
        stdin_data=b"", timeout=10, memory_limit=runner.RUN_MEMORY_BYTES, active_process_limit=1,
    )
    assert "BLOCKED" in result.stdout and "SPAWNED" not in result.stdout, result


def sandbox_cwd():
    from pathlib import Path
    return Path(tempfile.gettempdir())


# ------------------------------------------------------------------ 路由

@pytest.fixture()
def client():
    app = FastAPI()
    app.include_router(sandbox_router())
    with TestClient(app) as test_client:
        yield test_client


def post(client, payload, **kwargs):
    return client.post("/api/sandbox/run", json=payload, **kwargs)


def test_route_returns_the_task_contract(client):
    response = post(client, {
        "language": "python", "code": "print(int(input()) * 2)", "stdin": "",
        "test_cases": [{"input": "4", "expected": "8"}],
    })
    assert response.status_code == 200
    body = response.json()
    for key in ("ok", "stdout", "stderr", "exit_code", "test_results"):
        assert key in body
    assert body["ok"] is True and body["test_results"][0]["passed"] is True


def test_route_blocked_is_200_with_reason(client):
    body = post(client, {"language": "python", "code": "import socket"}).json()
    assert body["status"] == "blocked" and body["ok"] is False
    assert body["blocked"][0]["rule_id"] == "NET-01"


def test_route_validation_errors_are_422(client):
    assert post(client, {"language": "ruby", "code": "1"}).status_code == 422
    assert post(client, {"language": "python", "code": "print(1)\u0000"}).status_code == 422
    assert post(client, {"language": "python", "code": ""}).status_code == 422
    assert post(client, {"language": "python"}).status_code == 422


def test_route_rejects_non_local_clients_and_hosts():
    app = FastAPI()
    app.include_router(sandbox_router())
    payload = {"language": "python", "code": "print(1)"}
    with TestClient(app, client=("10.1.2.3", 5000)) as remote:
        assert post(remote, payload).status_code == 403
    with TestClient(app) as local:
        assert post(local, payload, headers={"host": "evil.example.com"}).status_code == 403
        assert post(local, payload, headers={"origin": "http://evil.example.com"}).status_code == 403
        assert post(local, payload, headers={"origin": "null"}).status_code == 403
        assert post(local, payload, headers={"origin": "http://localhost:3000"}).status_code == 200


def test_route_allows_configured_origin_and_remote_override(monkeypatch):
    app = FastAPI()
    app.include_router(sandbox_router(allowed_origins=["https://learn.example.com/"]))
    payload = {"language": "python", "code": "print(1)"}
    with TestClient(app) as local:
        assert post(local, payload, headers={"origin": "https://learn.example.com"}).status_code == 200
    monkeypatch.setenv(router_module.ALLOW_REMOTE_ENV, "1")
    with TestClient(app, client=("10.1.2.3", 5000)) as remote:
        assert post(remote, payload, headers={"host": "lab.example.com"}).status_code == 200


def test_route_returns_429_when_busy(client):
    held = []
    try:
        for _ in range(router_module.MAX_CONCURRENT_RUNS):
            assert router_module._slots.acquire(blocking=False)
            held.append(True)
        response = post(client, {"language": "python", "code": "print(1)"})
        assert response.status_code == 429 and "沙盒正忙" in response.json()["detail"]
    finally:
        for _ in held:
            router_module._slots.release()
    assert post(client, {"language": "python", "code": "print(1)"}).status_code == 200


def test_route_returns_503_when_toolchain_is_missing(client, monkeypatch):
    monkeypatch.setattr(runner.shutil, "which", lambda name: None)
    response = post(client, {"language": "javascript", "code": "console.log(1)"})
    assert response.status_code == 503 and "node" in response.json()["detail"]
    # 失败后槽位必须释放
    assert router_module._slots.acquire(blocking=False)
    router_module._slots.release()


def test_route_rejects_oversized_body(client):
    response = client.post(
        "/api/sandbox/run", content=b"x", headers={"content-type": "application/json", "content-length": "999999"},
    )
    assert response.status_code == 413


def test_route_checks_access_before_parsing_the_body():
    # 非本机客户端即使发来不合法的请求体，也应该是 403，而不是 422。
    app = FastAPI()
    app.include_router(sandbox_router())
    with TestClient(app, client=("10.1.2.3", 5000)) as remote:
        response = remote.post("/api/sandbox/run", json={"language": "ruby"})
    assert response.status_code == 403


# ------------------------------------------------------------------ 微件协议

def test_widget_guide_examples_are_valid_json_and_match_the_contract():
    blocks = re.findall(r"```knowgap-widget\n(.*?)\n```", WIDGET_SCHEMA_GUIDE, flags=re.S)
    parsed = [json.loads(block) for block in blocks]
    assert [item["type"] for item in parsed] == [
        "step_simulator", "comparison_matrix", "parameter_lab", "micro_quiz", "code_playground",
    ]
    assert "5 种类型" in WIDGET_SCHEMA_GUIDE
    spec = parsed[-1]
    assert spec["mode"] in ("scaffold", "free") and "TODO" in spec["starter_code"]
    request = RunRequest(language=spec["language"], code=spec["starter_code"], test_cases=spec["test_cases"])
    assert request.test_cases[0].expected == "9"
    assert check_security_blacklist(spec["starter_code"], spec["language"]) == []
    assert sys.version_info >= (3, 10)
