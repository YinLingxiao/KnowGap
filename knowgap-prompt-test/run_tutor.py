import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_MATERIALS = Path(r"D:\黑客松\C的任务提交\KnowGap-C\KnowGap-C\materials")
SMOKE = [
    "T01", "T05", "T09", "T13", "T15", "T16", "T18", "T20",
    "M01:1", "M01:2", "M01:3", "M01:4",
    "M05:1", "M05:2", "M05:3", "M05:4",
    "M06:1", "M06:2", "M06:3", "M06:4",
]
MAX_ATTEMPTS = 3
TIMEOUT_SECONDS = 120


def materials_dir():
    path = Path(os.environ.get("KNOWGAP_MATERIALS", str(DEFAULT_MATERIALS)))
    if not (path / "evaluate.py").is_file():
        raise SystemExit(f"找不到评测材料：{path}")
    return path


def load_evaluator():
    root = materials_dir()
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    import evaluate as ev
    return ev


def load_dotenv(path):
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        key, value = text.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def load_local_env():
    repo = Path(r"D:\黑客松\KnowGap")
    for path in (repo / ".env", repo / "backend" / ".env", SCRIPT_DIR / ".env"):
        load_dotenv(path)
    if not os.environ.get("LLM_API_KEY", "").strip() and os.environ.get("OPENAI_API_KEY", "").strip():
        os.environ["LLM_API_KEY"] = os.environ["OPENAI_API_KEY"]
    if not os.environ.get("LLM_BASE_URL", "").strip() and os.environ.get("OPENAI_BASE_URL", "").strip():
        os.environ["LLM_BASE_URL"] = os.environ["OPENAI_BASE_URL"]


def scrub(text, secret):
    if not text or not secret:
        return text
    return text.replace(secret, "[REDACTED]")


def require_config():
    load_local_env()
    names = ("LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL")
    missing = [name for name in names if not os.environ.get(name, "").strip()]
    if missing:
        print("缺少模型配置：" + "、".join(missing))
        print("配置方式：设置上述环境变量，或写入 knowgap-prompt-test/.env。不要把密钥写入代码、报告或对话。")
        print("LLM_BASE_URL 填写 Chat Completions 根地址，包含版本前缀，不含 /chat/completions。")
        print("LLM_MODEL 填写模型名称。LLM_API_KEY 填写密钥。也可使用 OPENAI_API_KEY、OPENAI_BASE_URL。")
        raise SystemExit(2)
    base_url = os.environ["LLM_BASE_URL"].strip().rstrip("/")
    parsed = urlsplit(base_url)
    valid = (
        parsed.scheme in {"http", "https"} and bool(parsed.hostname)
        and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
    )
    if not valid:
        print("LLM_BASE_URL 无效。请填写模型服务的 API 根地址。")
        raise SystemExit(2)
    return {
        "base_url": base_url,
        "api_key": os.environ["LLM_API_KEY"].strip(),
        "model": os.environ["LLM_MODEL"].strip(),
        "host": parsed.hostname,
    }


def read_prompt():
    return (materials_dir() / "prompt-v0.2.md").read_text(encoding="utf-8")


def append_jsonl(path, row):
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        handle.flush()


def ensure_run(ev, run_path):
    if run_path.exists():
        return
    ev.write_jsonl(run_path, ev.new_rows(ev.load_cases(), run_path.stem))


class UrllibChat:
    def __init__(self, base_url, api_key, timeout):
        self.base_url = base_url
        self.api_key = api_key
        self.timeout = timeout

    def post(self, payload):
        started = time.perf_counter()
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self.base_url + "/chat/completions",
            data=data,
            method="POST",
            headers={
                "Authorization": "Bearer " + self.api_key,
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read()
                status = response.status
                error = None
        except urllib.error.HTTPError as exc:
            body = exc.read()
            status = exc.code
            error = None
        except Exception as exc:
            elapsed = int(round((time.perf_counter() - started) * 1000))
            return {
                "http_status": None,
                "body_text": "",
                "error": scrub(f"{type(exc).__name__}: {exc}", self.api_key),
                "latency_ms": elapsed,
            }
        elapsed = int(round((time.perf_counter() - started) * 1000))
        return {
            "http_status": status,
            "body_text": scrub(body.decode("utf-8", errors="replace"), self.api_key),
            "error": error,
            "latency_ms": elapsed,
        }


def payload_for(model, system, user_content, temperature):
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_content},
        ],
    }
    if temperature is not None:
        body["temperature"] = temperature
    return body


def extract_content(body_text):
    try:
        parsed = json.loads(body_text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"响应不是 JSON：{exc}") from exc
    model_version = parsed.get("model") if isinstance(parsed.get("model"), str) else None
    choices = parsed.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise ValueError("响应缺少 choices")
    message = choices[0].get("message")
    if not isinstance(message, dict):
        raise ValueError("响应缺少 message")
    content = message.get("content")
    if not isinstance(content, str):
        raise ValueError("响应 content 不是字符串")
    if not content.strip():
        raise ValueError("响应 content 为空")
    return content, model_version


def retryable_status(status):
    return status in {408, 409, 429, 500, 502, 503, 504}


def call_case(client, model, system, user_content, secret, sleep):
    temperature = 0
    dropped_temperature = False
    attempts = []
    for attempt in range(1, MAX_ATTEMPTS + 1):
        body = payload_for(model, system, user_content, temperature)
        tested_at = datetime.now(timezone.utc).isoformat()
        result = client.post(body)
        record = {
            "attempt": attempt,
            "model": model,
            "model_version": None,
            "parameters": {"temperature": temperature, "timeout_seconds": TIMEOUT_SECONDS},
            "tested_at": tested_at,
            "latency_ms": result["latency_ms"],
            "request": {"method": "POST", "path": "/chat/completions", "body": body},
            "http_status": result["http_status"],
            "raw_response_body": result["body_text"],
            "raw_output": None,
            "error": result["error"],
            "retryable": False,
            "accepted": False,
        }
        if temperature is None:
            record["parameters"] = {"timeout_seconds": TIMEOUT_SECONDS}
        if result["error"]:
            record["retryable"] = True
        elif result["http_status"] == 400 and not dropped_temperature and "temperature" in result["body_text"].lower():
            record["error"] = "接口拒绝 temperature，将去掉该参数重试"
            record["retryable"] = True
            dropped_temperature = True
            temperature = None
        elif retryable_status(result["http_status"]):
            record["error"] = f"HTTP {result['http_status']}"
            record["retryable"] = True
        elif result["http_status"] != 200:
            record["error"] = f"HTTP {result['http_status']}"
        else:
            try:
                content, model_version = extract_content(result["body_text"])
            except ValueError as exc:
                record["error"] = str(exc)
                record["retryable"] = True
            else:
                record["raw_output"] = content
                record["model_version"] = model_version
                record["accepted"] = True
        if secret:
            record["error"] = scrub(record["error"], secret)
            record["raw_response_body"] = scrub(record["raw_response_body"], secret)
        attempts.append(record)
        if record["accepted"] or not record["retryable"] or attempt == MAX_ATTEMPTS:
            break
        sleep(min(2 ** (attempt - 1), 8))
    return attempts


def notes_for(attempts):
    accepted = next((item for item in attempts if item["accepted"]), None)
    failed = [item for item in attempts if not item["accepted"]]
    if accepted is None:
        detail = "；".join(
            f"第{item['attempt']}次 {item['error'] or '无错误信息'}" for item in attempts
        )
        return "调用失败，未录入回复。" + detail
    if not failed:
        return ""
    detail = "；".join(
        f"第{item['attempt']}次 {item['error'] or '无错误信息'}" for item in failed
    )
    return "此前调用失败，录入的是随后首次返回的原始 content，未按质量挑选。" + detail


def write_rows(ev, run_path, ordered):
    ev.write_jsonl(run_path, ordered)


def run_labels(ev, run_path, calls_path, labels, phase, client, model, system, secret, sleep):
    cases = ev.load_cases()
    ordered, rows = ev.load_run(run_path, cases)
    stopped = False
    for label in labels:
        if stopped:
            break
        row = rows[label]
        if row["status"] != "未测试":
            continue
        print(f"调用 {label}", flush=True)
        case = cases[label]
        if case["turn"] is not None:
            missing = None
            for turn in range(1, case["turn"]):
                previous = f"{case['test_id']}:{turn}"
                if rows[previous]["raw_output"] is None:
                    missing = previous
                    break
            if missing:
                row["status"] = "运行失败"
                row["notes"] = f"前置回合 {missing} 没有原始回复，未调用。"
                write_rows(ev, run_path, ordered)
                continue
        user_input = ev.prepare_input(label, cases, rows)
        user_content = json.dumps(user_input, ensure_ascii=False)
        attempts = call_case(client, model, system, user_content, secret, sleep)
        for item in attempts:
            item["case"] = label
            item["phase"] = phase
            append_jsonl(calls_path, item)
        accepted = next((item for item in attempts if item["accepted"]), None)
        last = attempts[-1]
        row["model"] = model
        row["parameters"] = dict(last["parameters"] if accepted is None else accepted["parameters"])
        row["tested_at"] = (accepted or last)["tested_at"]
        row["latency_ms"] = (accepted or last)["latency_ms"]
        row["model_version"] = None if accepted is None else accepted["model_version"]
        row["input_history"] = user_input["history"]
        row["notes"] = notes_for(attempts)
        if accepted is None:
            row["status"] = "运行失败"
            if case["turn"] is None:
                continue_same = True
            else:
                continue_same = False
            write_rows(ev, run_path, ordered)
            if not continue_same:
                stopped = False
            continue
        row["raw_output"] = accepted["raw_output"]
        row["status"] = "已录入"
        row["recorded_at"] = datetime.now(timezone.utc).isoformat()
        write_rows(ev, run_path, ordered)
    return ev.load_run(run_path, cases)


def history_errors(ev, run_path, calls_path, labels):
    cases = ev.load_cases()
    _, rows = ev.load_run(run_path, cases)
    logged = []
    if calls_path.exists():
        for line in calls_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                logged.append(json.loads(line))
    errors = []
    prompt = read_prompt()
    for label in labels:
        row = rows[label]
        if row["raw_output"] is None:
            errors.append(f"{label} 没有原始回复")
            continue
        prepared = ev.prepare_input(label, cases, rows)
        if row["input_history"] != prepared["history"]:
            errors.append(f"{label} 保存的历史与已录入对话不一致")
        accepted = [item for item in logged if item.get("case") == label and item.get("accepted")]
        if not accepted:
            errors.append(f"{label} 调用记录中没有被接受的回复")
            continue
        body = accepted[-1]["request"]["body"]
        messages = body["messages"]
        if messages[0]["content"] != prompt:
            errors.append(f"{label} 系统提示词与 prompt-v0.2.md 不一致")
        user_payload = json.loads(messages[1]["content"])
        if set(user_payload) != {"question", "reference", "student_answer", "history"}:
            errors.append(f"{label} 用户消息含有 input 以外的字段")
        if "expected" in messages[1]["content"]:
            errors.append(f"{label} 用户消息包含 expected")
        if user_payload["history"] != prepared["history"]:
            errors.append(f"{label} 发送历史与记录历史不一致")
        if accepted[-1]["raw_output"] != row["raw_output"]:
            errors.append(f"{label} 原始输出与被接受的回复不一致")
    return errors


def remaining_labels(ev):
    labels = []
    for label in ev.load_cases():
        if label not in SMOKE:
            labels.append(label)
    return labels


def run_phase(phase):
    if len(SMOKE) != 20:
        raise SystemExit("冒烟回合数不是 20")
    config = require_config()
    ev = load_evaluator()
    run_path = SCRIPT_DIR / "run-001.jsonl"
    calls_path = SCRIPT_DIR / "calls-001.jsonl"
    ensure_run(ev, run_path)
    client = UrllibChat(config["base_url"], config["api_key"], TIMEOUT_SECONDS)
    system = read_prompt()
    print(f"模型：{config['model']}；主机：{config['host']}；超时：{TIMEOUT_SECONDS} 秒")
    if phase in {"smoke", "all"}:
        run_labels(ev, run_path, calls_path, SMOKE, "smoke", client, config["model"], system, config["api_key"], time.sleep)
        errors = history_errors(ev, run_path, calls_path, SMOKE)
        if errors:
            print("冒烟检查未通过：")
            for error in errors:
                print(error)
            raise SystemExit(1)
        print("冒烟调用、记录和历史组装通过")
    if phase in {"rest", "all"}:
        _, rows = ev.load_run(run_path, ev.load_cases())
        missing = [label for label in SMOKE if rows[label]["raw_output"] is None]
        if missing:
            print("冒烟回合尚未全部录入，未继续剩余用例：" + "、".join(missing))
            raise SystemExit(1)
        run_labels(
            ev, run_path, calls_path, remaining_labels(ev), "rest",
            client, config["model"], system, config["api_key"], time.sleep,
        )
        print("剩余用例已执行")


class ScriptedChat:
    def __init__(self, responses):
        self.responses = list(responses)
        self.payloads = []

    def post(self, payload):
        self.payloads.append(payload)
        status, content, error = self.responses.pop(0)
        if error:
            return {"http_status": status, "body_text": "", "error": error, "latency_ms": 5}
        body = {"model": "harness-fake", "choices": [{"message": {"content": content}}]}
        return {
            "http_status": status,
            "body_text": json.dumps(body, ensure_ascii=False),
            "error": None,
            "latency_ms": 5,
        }


def check_harness():
    ev = load_evaluator()
    prompt = read_prompt()
    cases = ev.load_cases()
    folder = SCRIPT_DIR / "_harness"
    if folder.exists():
        for child in folder.iterdir():
            child.unlink()
    else:
        folder.mkdir()
    run_path = folder / "harness-run.jsonl"
    calls_path = folder / "harness-calls.jsonl"
    ev.write_jsonl(run_path, ev.new_rows(cases, "harness"))
    scripted = []
    for label in SMOKE:
        if label == "M01:1":
            scripted.append((200, "格式错误回复，没有大括号", None))
        elif label == "T16":
            scripted.append((503, None, None))
            scripted.append((200, "第二次才返回", None))
        else:
            answer = cases[label]["input"]["student_answer"]
            scripted.append((200, "RAW::" + answer, None))
    client = ScriptedChat(scripted)
    run_labels(ev, run_path, calls_path, SMOKE, "smoke", client, "harness-fake", prompt, "", lambda _seconds: None)
    errors = history_errors(ev, run_path, calls_path, SMOKE)
    _, rows = ev.load_run(run_path, cases)
    if rows["M01:2"]["input_history"][1]["content"] != "格式错误回复，没有大括号":
        errors.append("格式错误回复没有原样进入下一轮历史")
    if rows["T16"]["raw_output"] != "第二次才返回":
        errors.append("重试后没有保留首次成功返回的内容")
    t16_attempts = [json.loads(line) for line in calls_path.read_text(encoding="utf-8").splitlines() if '"T16"' in line]
    if len(t16_attempts) != 2:
        errors.append("T16 重试记录数量不对")
    auth_run = folder / "auth-run.jsonl"
    auth_calls = folder / "auth-calls.jsonl"
    ev.write_jsonl(auth_run, ev.new_rows(cases, "harness-auth"))
    auth_client = ScriptedChat([(401, None, None)])
    auth_client.responses = [(401, None, None)]
    # ScriptedChat treats non-200 without error as JSON body. Rebuild for HTTP 401.
    class StatusChat:
        def post(self, payload):
            return {"http_status": 401, "body_text": "{\"error\":\"denied\"}", "error": None, "latency_ms": 3}

    run_labels(ev, auth_run, auth_calls, ["T01"], "smoke", StatusChat(), "harness-fake", prompt, "", lambda _seconds: None)
    _, auth_rows = ev.load_run(auth_run, cases)
    if auth_rows["T01"]["status"] != "运行失败" or auth_rows["T01"]["raw_output"] is not None:
        errors.append("鉴权失败不应录入回复")
    auth_lines = [line for line in auth_calls.read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(auth_lines) != 1:
        errors.append("不可重试的失败不应继续请求")
    if errors:
        print("调用脚本自检失败：")
        for error in errors:
            print(error)
        raise SystemExit(1)
    print("调用脚本自检通过：历史保留格式错误回复，失败与重试均有记录")
    for child in folder.iterdir():
        child.unlink()
    folder.rmdir()


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if "--check-harness" in sys.argv:
        check_harness()
        return
    phase = "all"
    if "--phase" in sys.argv:
        phase = sys.argv[sys.argv.index("--phase") + 1]
    if phase not in {"smoke", "rest", "all"}:
        raise SystemExit("phase 只能是 smoke、rest 或 all")
    run_phase(phase)


if __name__ == "__main__":
    main()
