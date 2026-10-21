# Vision relay evaluation

Date: 2026-10-21

This directory contains scripts for validating the vision/logic relay. Textbook scans, screenshots, generated samples, provider responses, and local stores are excluded by `.gitignore`; they are evaluation inputs only and are never used to train a model.

## Runtime models

- Vision (“eyes”): `qwen3.5-plus`
- Logic (“brain”): `gemini-4-argon`
- Both were called through the configured OpenAI-compatible endpoint.
- Secrets are loaded from backend configuration and are never printed by these scripts.

## Scripts

```text
backend/.venv/Scripts/python.exe -X utf8 -I eval/vision/smoke.py
backend/.venv/Scripts/python.exe -X utf8 -I eval/vision/probe.py --concurrency 2
```

- `smoke.py` uses a generated 1×1 image and a trivial arithmetic prompt to test connectivity without uploading evaluation material.
- `probe.py` runs the full relay over `samples/manifest.json`, compares circuit topology independent of node names, checks coordinate order against handwritten line boxes, measures error localization, and records effort routing and latency.
- `diag_vision.py` is a targeted provider diagnostic for comparing Qwen thinking on/off. It intentionally reads a local evaluation sample and must only be run when sending that sample to the configured provider is authorized.
- Machine-readable output is written under `results/` and remains local.

## Provider diagnostics

A focused diagnostic completed successfully before the full probe:

| Request | Observed latency |
| --- | ---: |
| text only | 5.6 s |
| image, `enable_thinking=false` | 12.7 s |
| image, thinking enabled | 23.6 s |
| minimal Gemini JSON response | 5.2–5.8 s |

Qwen thinking was therefore disabled for objective extraction. This does not reduce the logic model’s reasoning effort; the logic stage is routed independently.

## Initial 18-sample probe

The first full run used a 60-second provider timeout and four concurrent requests.

- 18 samples total: 13 completed, 5 timed out.
- Scene classification: 11/13 among completed samples.
- Both misses were simple analog circuit problems that also contained waveform plots; they were classified as general problems.
- All five dense handwritten pages timed out during extraction, so that run did **not** produce a valid handwriting coordinate or error-localization score.

Circuit topology results (node labels are remapped before comparison):

| Sample | Expected branches | Matched | Predicted | Exact structure | Matching values |
| --- | ---: | ---: | ---: | --- | ---: |
| `cee_c1-06a` | 2 | 2 | 2 | yes | 2/2 |
| `cee_c3-01` | 2 | 0 | 0 | no; scene miss | — |
| `cee_c3-02` | 2 | 0 | 0 | no; scene miss | — |
| `cee_c3-05` | 8 | 6 | 7 | no | 5/6 matched branches |
| `cee_c1-16b` | 4 | 4 | 4 | yes | 2/4 |
| `cee_c3-08` | 6 | 4 | 6 | no | 3/4 matched branches |

The simple single-loop sample routed to `low`; completed complex analog circuits routed to `high`. Concept-classified digital-logic questions routed to `low`, while multi-step calculations routed to `high`. One nominally simple printed exercise was estimated as five steps and routed to `high`; the router follows extracted task complexity rather than the manifest label.

## Changes made after the initial probe

- The extraction prompt now says that an analog circuit remains `circuit` even when the same image contains printed text, a waveform, switching timing, or formulas; digital logic gates remain `problem`.
- The default dense-page timeout is 120 seconds (an explicit `VISION_TIMEOUT_SECONDS` environment value still takes precedence).
- Qwen extraction keeps `enable_thinking=false`.
- Extraction cache keys include `GROUNDING_CACHE_VERSION`, so prompt-contract changes cannot silently reuse older output.
- Authoritative widget JSON is returned out-of-band in `widget_markdown` and must be prepended to the displayed reply only after inference. The logic model receives text and region IDs, never image data, URLs, bounding boxes, or SVG coordinates.
- Circuit output remains a student-confirmed draft. The measured non-exact cases are the reason the logic model is not allowed to solve directly from unconfirmed visual topology.

## Targeted rerun status

A serial rerun of the two scene misses and five handwritten pages was attempted with a 120-second timeout. All seven requests were rejected immediately by the configured provider with an access/permission response. A subsequent tiny-image/text smoke check showed the same access rejection for both configured models. No key or provider response body containing credentials was logged.

Consequently, the prompt and timeout changes pass deterministic tests but could not be re-scored against the live provider in the final environment. Do not interpret the initial run as a handwriting accuracy result, and do not claim that the two scene misses are fixed until a provider-authorized rerun completes.

## Deterministic verification

At the time of this report:

- Vision backend tests: 90 passed.
- Full backend tests: 607 passed (one third-party deprecation warning).
- Frontend API/widget tests: 51 passed.
- Frontend TypeScript, ESLint, and production build passed.

The backend tests use `httpx.MockTransport`; they cover key redaction, model fallback, dual/single-model judging, coordinate normalization, topology confirmation/versioning, image isolation and content sniffing, URL rejection, cache behavior, and error sanitization without calling a provider.
