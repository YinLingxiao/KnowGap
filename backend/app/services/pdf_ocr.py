"""扫描版 PDF：把页面渲染成图片，交给已配置的多模态识图模型转写成文字。

不自带 OCR 引擎（体积大、中文效果一般），复用「服务模型分工」里的识图模型。没有配置识图模型时如实告诉学生怎么办。
"""

import asyncio
import base64
import io
import re

import httpx

from app.agents.llm import PROVIDER_FAILURES, ProviderError, is_vertex_native, request_error, shared_ssl_context, status_error
from app.services.office_readers import Reading

MAX_OCR_PAGES = 12
OCR_CONCURRENCY = 3
RENDER_EDGE = 1700  # 页面长边像素：够看清小号字，又不至于把请求撑到几 MB
OCR_PROMPT = (
    "你是文档转写员。把这一页文档图片里的文字逐字转写出来，保持原有阅读顺序和段落；"
    "标题用 # 标记，表格用 Markdown 表格，公式用文字或 LaTeX 写出，图片和插图用「[图：简短描述]」代替。"
    "看不清的字写「□」，不要猜测、补写或总结。只输出转写内容，不要加任何说明。"
)


def render_pages(data: bytes, limit: int = MAX_OCR_PAGES) -> tuple[list[bytes], int]:
    """(前 limit 页的 PNG, 总页数)。"""
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(data)
    try:
        total = len(document)
        images = []
        for index in range(min(total, limit)):
            page = document[index]
            width, height = page.get_size()
            scale = min(2.2, RENDER_EDGE / max(width, height, 1))
            buffer = io.BytesIO()
            page.render(scale=scale).to_pil().convert("RGB").save(buffer, format="PNG", optimize=True)
            images.append(buffer.getvalue())
        return images, total
    finally:
        document.close()


def _clean(content) -> str:
    if isinstance(content, list):  # 个别网关把内容拆成片段列表
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    text = str(content or "").strip()
    text = re.sub(r"^```(?:markdown|text)?\s*\n|\n```\s*$", "", text)
    return text.replace("\x00", "")


async def _ocr_page_native(url: str, config, transport: httpx.AsyncBaseTransport | None, prompt: str = OCR_PROMPT) -> str:
    """Vertex / Gemini 原生接口没有 /chat/completions，走和对话相同的原生通道。"""
    from app.agents.gemini import GeminiNativeChat

    messages = [{"role": "user", "content": [
        {"type": "image_url", "image_url": {"url": url}},
        {"type": "text", "text": prompt},
    ]}]
    chat = GeminiNativeChat(config.llm_settings(), transport)
    return _clean("".join([value async for kind, value in chat.stream(messages) if kind == "text"]))


async def _ocr_page(png: bytes, config, transport: httpx.AsyncBaseTransport | None, prompt: str = OCR_PROMPT) -> str:
    url = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
    if is_vertex_native(config.base_url):
        return await _ocr_page_native(url, config, transport, prompt)
    payload = {
        "model": config.model, "temperature": 0,
        "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": url}},
            {"type": "text", "text": prompt},
        ]}],
    }
    if config.disable_thinking and re.search(r"qwen|qvq", config.model, re.IGNORECASE):
        payload["enable_thinking"] = False
    try:
        async with httpx.AsyncClient(timeout=config.timeout_seconds, transport=transport, verify=shared_ssl_context()) as client:
            response = await client.post(f"{config.base_url}/chat/completions", json=payload,
                                         headers={"Authorization": f"Bearer {config.api_key.get_secret_value()}"})
    except PROVIDER_FAILURES as exc:
        raise request_error(exc) from None
    error = status_error(response.status_code)
    if error:
        raise error
    try:
        content = response.json()["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError):
        raise ProviderError(502, "识图模型的返回无法解析。") from None
    return _clean(content)


async def ocr_pdf(data: bytes, service_models, *, transport: httpx.AsyncBaseTransport | None = None) -> Reading:
    """返回识别结果；没配置识图模型、或一页都没识别出来时抛 ProviderError（带可读原因）。"""
    config = service_models.vision_config(service_models.config())
    if not config.configured:
        raise ProviderError(503, "这份 PDF 是扫描图片。到「设置 → 模型」配置一个多模态识图模型后，就能识别里面的文字；也可以换成带文字层的版本。")
    images, total = await asyncio.to_thread(render_pages, data)
    gate = asyncio.Semaphore(OCR_CONCURRENCY)

    async def one(number: int, png: bytes):
        async with gate:
            try:
                return number, await _ocr_page(png, config, transport), None
            except ProviderError as exc:
                return number, "", exc.detail

    results = sorted(await asyncio.gather(*(one(number, png) for number, png in enumerate(images, start=1))))
    pages = [(number, text) for number, text, _ in results if text.strip()]
    failures = [(number, reason) for number, text, reason in results if reason]
    if not pages:
        reason = failures[0][1] if failures else "没有识别出文字"
        raise ProviderError(502, f"这份 PDF 是扫描图片，识图模型没能识别出文字：{reason}")
    notes = ["这份 PDF 是扫描图片，文字由识图模型识别，可能有错字、漏字，公式和表格尤其要核对原件。"]
    if total > len(images):
        notes.append(f"只识别了前 {len(images)} 页（共 {total} 页），后面的页没有读取。")
    if failures:
        notes.append("第 " + "、".join(str(number) for number, _ in failures) + " 页识别失败，没有读取。")
    blank = [number for number, text, reason in results if not text.strip() and not reason]
    if blank:
        notes.append("第 " + "、".join(map(str, blank)) + " 页没有识别到文字。")
    return Reading(pages, notes, extra={number: text for number, text in pages})
