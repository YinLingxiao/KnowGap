"""Real-model probe over eval/vision/samples/manifest.json, through the real two-model relay.

Measures: scene detection, circuit netlist topology (node names may differ; structure is compared),
whether the configured bbox format is right, handwritten error localization, effort routing, latency.

Run:     backend/.venv/Scripts/python.exe -X utf8 -I eval/vision/probe.py [--only id1,id2] [--concurrency 4]
Output:  eval/vision/results/probe/ (git-ignored). Calls the configured provider; never prints API keys.
         Extractions are cached per image, so a rerun only re-calls the logic model.
"""

import argparse
import asyncio
import base64
import itertools
import json
import re
import sys
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.agents.llm import ProviderError  # noqa: E402
from app.config import Settings  # noqa: E402
from app.services.ai_settings import AISettings  # noqa: E402
from app.vision import circuit_netlist as cn  # noqa: E402
from app.vision.grounding import GROUNDING_CACHE_VERSION  # noqa: E402
from app.vision.pipeline import AnalysisError, analyze_image_for_relay  # noqa: E402
from app.vision.schemas import VisionAnalyzeRequest  # noqa: E402
from app.vision.settings import ServiceModels  # noqa: E402
from app.vision.store import VisionStore, sniff_image  # noqa: E402

SAMPLES = ROOT / "eval" / "vision" / "samples"
OUT = ROOT / "eval" / "vision" / "results" / "probe"
STUDENT = "probe"
EXPECTED_SCENE = {"circuit": "circuit", "handwritten": "handwriting", "logic_circuit": "general", "problem": "general"}
TEACHER_MARKED = {"hw_01", "hw_02"}  # red-pen corrections already on the photo


# ---------------------------------------------------------------- netlist comparison

def _norm_value(value: str) -> str:
    return re.sub(r"\s|Ω|ω|ohm|欧", "", (value or "").lower())


def compare_netlists(pred: cn.Netlist, exp: cn.Netlist) -> dict:
    """Best node mapping (names differ between model and answer key), then branch matching by element."""
    pnodes = sorted({n for b in pred.branches for n in (b.from_, b.to)})
    enodes = sorted({n for b in exp.branches for n in (b.from_, b.to)})
    size = max(len(pnodes), len(enodes))
    if size > 9:
        return {"skipped": f"{size} 个节点，超过穷举上限"}
    expected = Counter((b.element, frozenset((b.from_, b.to))) for b in exp.branches)
    expected_edges = Counter(frozenset((b.from_, b.to)) for b in exp.branches)
    targets = enodes + [f"_x{i}" for i in range(size - len(enodes))]
    best_score, best_map = -1, {}
    for perm in itertools.permutations(targets, len(pnodes)):
        mapping = dict(zip(pnodes, perm))
        got = Counter((b.element, frozenset((mapping[b.from_], mapping[b.to]))) for b in pred.branches)
        score = sum((got & expected).values())
        if score > best_score:
            best_score, best_map = score, mapping
            if score == len(exp.branches):
                break
    edges = Counter(frozenset((best_map[b.from_], best_map[b.to])) for b in pred.branches)
    pool = list(exp.branches)
    values_ok = values_total = 0
    for branch in pred.branches:
        sig = (branch.element, frozenset((best_map[branch.from_], best_map[branch.to])))
        for i, other in enumerate(pool):
            if (other.element, frozenset((other.from_, other.to))) == sig:
                pool.pop(i)
                if other.value:
                    values_total += 1
                    values_ok += _norm_value(branch.value) == _norm_value(other.value)
                break
    return {
        "nodes": [len(pnodes), len(enodes)], "branches": [len(pred.branches), len(exp.branches)],
        "matched": best_score, "recall": round(best_score / len(exp.branches), 3),
        "precision": round(best_score / len(pred.branches), 3) if pred.branches else 0.0,
        "wiring_only_matched": sum((edges & expected_edges).values()),
        "exact": best_score == len(exp.branches) == len(pred.branches),
        "values": [values_ok, values_total],
    }


# ---------------------------------------------------------------- handwritten geometry

def _to_norm(box, width, height):
    x1, y1, x2, y2 = box
    return (y1 / height * 1000, x1 / width * 1000, y2 / height * 1000, x2 / width * 1000)


def _center(box):
    return ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)


def _inside(point, box, pad_y):
    y, x = point
    return box[0] - pad_y <= y <= box[2] + pad_y and box[1] - 30 <= x <= box[3] + 30


def line_boxes(sample, width, height) -> dict[int, tuple]:
    boxes = {}
    for item in sample.get("handwritten_lines") or []:
        if isinstance(item.get("line"), int) and isinstance(item.get("bbox"), list) and len(item["bbox"]) == 4:
            boxes[item["line"]] = _to_norm(item["bbox"], width, height)
    return boxes


def region_hit_rate(regions, boxes) -> dict:
    """Share of predicted regions whose center lands on some answer-key line, as configured and swapped."""
    if not regions or not boxes:
        return {}
    def rate(transform):
        hits = 0
        for region in regions:
            center = _center(transform(region))
            hits += any(_inside(center, box, (box[2] - box[0]) * 0.25) for box in boxes.values())
        return round(hits / len(regions), 3)
    return {"configured": rate(lambda b: b), "swapped_xy": rate(lambda b: (b[1], b[0], b[3], b[2]))}


def error_localization(sample, annotations, boxes) -> dict:
    expected = [e for e in sample["expected"].get("errors") or [] if isinstance(e.get("line"), int)]
    scored = [e for e in expected if e.get("confidence") in {"high", "medium"}]
    centers = [_center(a["bbox"]) for a in annotations]

    def hit(error):
        box = boxes.get(error["line"])
        if box is None:
            return None
        pad = max((box[2] - box[0]) * 0.6, 8)  # about one line of tolerance: boxes are approximate
        return any(_inside(c, box, pad) for c in centers)

    recall_hits = [hit(e) for e in scored]
    precision_hits = 0
    for c in centers:
        precision_hits += any(
            _inside(c, boxes[e["line"]], max((boxes[e["line"]][2] - boxes[e["line"]][0]) * 0.6, 8))
            for e in expected if e["line"] in boxes)
    return {
        "expected_errors": len(scored), "found": sum(1 for h in recall_hits if h),
        "unlocatable": sum(1 for h in recall_hits if h is None),
        "predicted": len(annotations), "predicted_on_error_lines": precision_hits,
        "expected_lines": [e["line"] for e in scored],
    }


# ---------------------------------------------------------------- run

async def run_one(sample, service_models, store, gate) -> dict:
    data = (SAMPLES / sample["file"]).read_bytes()
    mime, width, height = sniff_image(data)
    url = f"data:{mime};base64,{base64.b64encode(data).decode()}"
    record = {"id": sample["id"], "kind": sample["kind"], "difficulty": sample["difficulty"],
              "capture": sample["capture"], "teacher_marked": sample["id"] in TEACHER_MARKED}
    async with gate:
        started = time.monotonic()
        try:
            result = await analyze_image_for_relay(
                VisionAnalyzeRequest(image_url=url, mode="auto"), service_models, store=store, student_id=STUDENT)
        except (ProviderError, AnalysisError) as exc:
            record["error"] = f"{getattr(exc, 'status_code', 422)} {getattr(exc, 'detail', str(exc))}"
            record["seconds"] = round(time.monotonic() - started, 1)
            return record
        record["seconds"] = round(time.monotonic() - started, 1)
    record.update(scene=result["scene"], scene_ok=result["scene"] == EXPECTED_SCENE[sample["kind"]],
                  mode=result["mode"], effort=result["recommended_effort"], route=result["route"]["reason"],
                  cached=result["cached"], judge=result["models"]["judge"])

    cfg = service_models.vision_config()
    cache_key = f"{GROUNDING_CACHE_VERSION}|{cfg.model}|{cfg.bbox_format}|extract"
    cached = store.cached_extraction(STUDENT, result["image"]["image_id"], cache_key)
    regions = [tuple(r["bbox"]) for r in (cached or {}).get("regions", [])]
    record["regions"] = len(regions)

    expected_netlist = (sample["expected"] or {}).get("netlist")
    if sample["kind"] == "circuit" and expected_netlist:
        exp = cn.parse_netlist(expected_netlist)
        draft = (cached or {}).get("netlist")
        if draft:
            try:
                record["netlist"] = compare_netlists(cn.parse_netlist(draft), exp)
            except ValueError as exc:
                record["netlist"] = {"invalid": str(exc)}
        else:
            record["netlist"] = {"missing": True}

    if sample["kind"] == "handwritten":
        boxes = line_boxes(sample, width, height)
        record["line_hit_rate"] = region_hit_rate(regions, boxes)
        annotations = (result["widget"] or {}).get("annotations", [])
        record["errors"] = error_localization(sample, annotations, boxes)
        record["annotations"] = [{"id": a["id"], "label": a["label"]} for a in annotations]
    return record


def summarize(records: list[dict]) -> str:
    out = []
    ok = [r for r in records if "error" not in r]
    out.append(f"样本 {len(records)}，成功 {len(ok)}，失败 {len(records) - len(ok)}")
    for r in records:
        if "error" in r:
            out.append(f"  失败 {r['id']}: {r['error']} ({r['seconds']}s)")
    out.append(f"场景识别正确 {sum(r['scene_ok'] for r in ok)}/{len(ok)}")
    for r in ok:
        if not r["scene_ok"]:
            out.append(f"  场景错 {r['id']}: 期望 {EXPECTED_SCENE[r['kind']]} 实际 {r['scene']}")

    out.append("\n电路网表（节点名不同不扣分，比较结构）")
    for r in ok:
        if "netlist" in r:
            n = r["netlist"]
            if "recall" in n:
                out.append(f"  {r['id']:<12} {r['difficulty']:<7} 支路命中 {n['matched']}/{n['branches'][1]}"
                           f"（预测 {n['branches'][0]}，只看连线 {n['wiring_only_matched']}），节点 {n['nodes'][0]}/{n['nodes'][1]}，"
                           f"参数一致 {n['values'][0]}/{n['values'][1]}，完全一致 {'是' if n['exact'] else '否'}")
            else:
                out.append(f"  {r['id']:<12} {n}")

    out.append("\n坐标格式校验（预测区域中心落在标准行框内的比例）")
    for r in ok:
        if r.get("line_hit_rate"):
            out.append(f"  {r['id']:<6} 按配置格式 {r['line_hit_rate']['configured']:.0%}，"
                       f"x/y 互换 {r['line_hit_rate']['swapped_xy']:.0%}（{r['regions']} 个区域）")

    out.append("\n手写判错定位（只计 high/medium 置信度；±1 行容差）")
    for r in ok:
        if "errors" in r:
            e = r["errors"]
            flag = "（原图有老师红笔，单独看）" if r["teacher_marked"] else ""
            out.append(f"  {r['id']:<6} 找到 {e['found']}/{e['expected_errors']}（期望行 {e['expected_lines']}），"
                       f"红圈 {e['predicted']} 个，其中 {e['predicted_on_error_lines']} 个落在错误行{flag}")
            for a in r["annotations"]:
                out.append(f"         - {a['id']}: {a['label']}")

    out.append("\n思考档位路由")
    for r in ok:
        out.append(f"  {r['id']:<12} {r['kind']:<13} {r['difficulty']:<7} -> {r['effort']:<6} {r['route']}  {r['seconds']}s"
                   + ("（缓存）" if r["cached"] else ""))
    return "\n".join(out)


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default="")
    parser.add_argument("--concurrency", type=int, default=2)
    args = parser.parse_args()
    manifest = json.loads((SAMPLES / "manifest.json").read_text(encoding="utf-8"))
    samples = manifest["samples"]
    if args.only:
        wanted = set(args.only.split(","))
        samples = [s for s in samples if s["id"] in wanted]
    service_models = ServiceModels(AISettings(Settings()))
    cfg = service_models.vision_config()
    logic, _ = service_models.logic_settings()
    print(f"识图模型 {cfg.model}（{cfg.source}，坐标 {cfg.bbox_format}），逻辑模型 {logic.llm_model}，样本 {len(samples)}",
          flush=True)
    OUT.mkdir(parents=True, exist_ok=True)
    store = VisionStore(OUT / "store")
    gate = asyncio.Semaphore(args.concurrency)
    started = time.monotonic()
    records = await asyncio.gather(*(run_one(s, service_models, store, gate) for s in samples))
    report = summarize(list(records)) + f"\n\n总耗时 {time.monotonic() - started:.0f}s"
    (OUT / "records.json").write_text(json.dumps(records, ensure_ascii=False, indent=1), encoding="utf-8")
    (OUT / "report.txt").write_text(report, encoding="utf-8")
    print(report)


if __name__ == "__main__":
    asyncio.run(main())
