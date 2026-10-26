"""search_good_problems 的单元测试：provider、LLM、网页全部用假数据，不联网、不调模型。"""

import asyncio
import json
from collections import Counter
from types import SimpleNamespace

import httpx
import pytest

from app.agent_tools import problem_search as ps
from app.models.schemas import SourceReference

# 一个结构完整的真题页面：例1 计算题（带考试出处），例2 选择题
PAGE = (
    "2019 年全国硕士研究生入学统一考试 数学一 真题解析\n"
    "本文整理定积分换元法的两道典型题，换元时要同时改变积分上下限，并注意新变量的取值范围是否单调。\n"
    "例1 计算定积分 $\\int_0^4 \\frac{dx}{1+\\sqrt{x}}$。\n"
    "答案：$4-2\\ln 3$\n"
    "解析：令 $t=\\sqrt{x}$，则 $x=t^2$，$dx=2t\\,dt$，当 $x=0$ 时 $t=0$，当 $x=4$ 时 $t=2$。"
    "原式 $=\\int_0^2 \\frac{2t}{1+t}dt=2[t-\\ln(1+t)]_0^2=4-2\\ln 3$。\n"
    "例2 设 $f(x)$ 连续，则 $\\int_0^1 f(1-x)dx$ 等于（ ）\n"
    "A. $\\int_0^1 f(x)dx$  B. $-\\int_0^1 f(x)dx$  C. $2\\int_0^1 f(x)dx$  D. $0$\n"
    "答案：A\n"
    "解析：令 $u=1-x$，则 $dx=-du$，积分限由 $0\\to1$ 变为 $1\\to0$，故原式 $=\\int_1^0 f(u)(-du)=\\int_0^1 f(u)du$，选 A。\n"
)

PROBLEM_1 = {
    "stem": "计算定积分 $\\int_0^4 \\frac{dx}{1+\\sqrt{x}}$。",
    "options": None,
    "answer": "$4-2\\ln 3$",
    "solution": "令 $t=\\sqrt{x}$，则 $x=t^2$，$dx=2t\\,dt$，当 $x=0$ 时 $t=0$，当 $x=4$ 时 $t=2$。"
                "原式 $=\\int_0^2 \\frac{2t}{1+t}dt=2[t-\\ln(1+t)]_0^2=4-2\\ln 3$。",
    "exam_tag": "2019 考研数学一",
    "knowledge_points": ["定积分换元法"],
    "pattern": "定积分换元-积分限同步变换",
    "type": "计算", "difficulty": "中等", "has_figure": False,
}

PROBLEM_2 = {
    "stem": "设 $f(x)$ 连续，则 $\\int_0^1 f(1-x)dx$ 等于（ ）",
    "options": ["A. $\\int_0^1 f(x)dx$", "B. $-\\int_0^1 f(x)dx$", "C. $2\\int_0^1 f(x)dx$", "D. $0$"],
    "answer": "A",
    "solution": "令 $u=1-x$，则 $dx=-du$，积分限由 $0\\to1$ 变为 $1\\to0$，故原式 $=\\int_1^0 f(u)(-du)=\\int_0^1 f(u)du$，选 A。",
    "exam_tag": None,
    "knowledge_points": ["定积分换元法"],
    "pattern": "定积分换元-对称代换",
    "type": "选择", "difficulty": "基础", "has_figure": False,
}

KP = "定积分换元法"


@pytest.fixture(autouse=True)
def fresh_cache(monkeypatch):
    ps.clear_cache()
    monkeypatch.setattr(ps, "_env", lambda name: "")  # 不读本机真实密钥
    yield
    ps.clear_cache()


def page(text=PAGE, url="https://math.a.edu.cn/kaoyan/2019", title="2019 考研数学一 定积分真题", origin="web"):
    hit = ps.RawHit(url=url, title=title, site="a.edu.cn", content=text, origin=origin)
    return ps.Page(hit, ps.normalize_text(text))


def build(raw, pg=None):
    return ps.build_candidate(raw, pg or page(), KP, "2026-10-20")


# ------------------------------------------------------------ query 增强

def test_queries_cover_intents_and_respect_limits():
    default = ps.build_queries(ps.SearchGoodProblemsInput(knowledge_point=KP))
    assert [intent for intent, _ in default] == ["考研真题", "经典母题"]
    assert all(KP in query for _, query in default)

    hard = ps.build_queries(ps.SearchGoodProblemsInput(
        knowledge_point=KP, difficulty="拔高", misconception_hints=["换元后未同步改积分限" * 3, "符号"]))
    intents = [intent for intent, _ in hard]
    assert intents == ["考研真题", "经典母题", "竞赛原题", "易错"]
    assert len(hard) <= ps.MAX_QUERIES and all(len(q) <= 100 for _, q in hard)
    assert "换元后未同步改积分限" in hard[-1][1] and len(hard[-1][1]) < 60  # 误区词被截短

    same = ps.build_queries(ps.SearchGoodProblemsInput(knowledge_point=KP, pattern="积分限同步变换"))
    assert same[0] == ("同型", f"{KP} 积分限同步变换 例题 解析")

    only = ps.build_queries(ps.SearchGoodProblemsInput(knowledge_point=KP, prefer=["竞赛原题"], difficulty="拔高"))
    assert [intent for intent, _ in only] == ["竞赛原题"]


def test_input_is_clamped_instead_of_rejected():
    inp = ps.SearchGoodProblemsInput(knowledge_point="  「定积分」 ", count=99,
                                     exclude_fingerprints=["0123456789abcdef", "bad", 7])
    assert inp.knowledge_point == "定积分" and inp.count == ps.MAX_COUNT
    assert inp.exclude_fingerprints == ["0123456789abcdef"]


# ------------------------------------------------------------ provider

def test_volcengine_wire_format_and_nested_rows():
    seen = {}

    def handle(request):
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={
            "ResponseMetadata": {"RequestId": "r1"},
            "Result": {"WebResults": [
                {"Title": "定积分真题", "Url": "https://math.a.edu.cn/p1", "SiteName": "某大学", "Snippet": "s",
                 "Content": "正文"},
                {"Title": "坏链接", "Url": "javascript:alert(1)"},
                {"Title": "", "Url": "https://b.example.com/p2", "Snippet": 3},
            ]},
        })

    provider = ps.VolcengineSearchProvider("synthetic-volc-key", httpx.MockTransport(handle))
    hits = asyncio.run(provider.search("定积分换元法 考研真题 详细解析", 5))
    assert seen["url"] == "https://open.feedcoopapi.com/search_api/web_search"
    assert seen["auth"] == "Bearer synthetic-volc-key"
    body = seen["body"]
    assert body["Query"] == "定积分换元法 考研真题 详细解析" and body["SearchType"] == "web" and body["Count"] == 5
    assert body["Filter"]["NeedContent"] is True and body["Filter"]["NeedUrl"] is True
    assert len(body["Filter"]["BlockHosts"].split("|")) <= 5 and body["ContentFormats"] == "markdown"
    assert [h.url for h in hits] == ["https://math.a.edu.cn/p1", "https://b.example.com/p2"]
    assert hits[0].site == "某大学" and hits[0].content == "正文"
    assert hits[1].title == "b.example.com" and hits[1].snippet == "3"


@pytest.mark.parametrize("body", [{"data": {"results": [{"url": "https://x.example.com/a"}]}},
                                  {"Result": [{"Url": "https://x.example.com/a"}]}])
def test_volcengine_accepts_alternative_layouts(body):
    provider = ps.VolcengineSearchProvider("k", httpx.MockTransport(lambda _: httpx.Response(200, json=body)))
    assert [h.url for h in asyncio.run(provider.search("q", 5))] == ["https://x.example.com/a"]


@pytest.mark.parametrize("status,body,kind", [
    (401, {"message": "api_key=synthetic-volc-key"}, "auth"),
    (429, {"message": "password=private"}, "quota"),
    (500, {}, "http"),
    (200, {"ResponseMetadata": {"Error": {"Message": "token=private"}}}, "provider"),
    (200, {"Result": {"Nothing": 1}}, "format"),
])
def test_provider_failures_never_carry_server_text(status, body, kind):
    provider = ps.VolcengineSearchProvider("synthetic-volc-key",
                                           httpx.MockTransport(lambda _: httpx.Response(status, json=body)))
    with pytest.raises(ps.SearchFailure) as error:
        asyncio.run(provider.search("q", 5))
    assert error.value.kind == kind and "private" not in str(error.value) and "synthetic" not in str(error.value)


def test_provider_timeout_is_classified():
    def timeout(request):
        raise httpx.ReadTimeout("private")
    provider = ps.TavilyProvider("k", httpx.MockTransport(timeout))
    with pytest.raises(ps.SearchFailure) as error:
        asyncio.run(provider.search("q", 5))
    assert error.value.kind == "timeout"


def test_tavily_requests_raw_content():
    def handle(request):
        body = json.loads(request.content)
        assert request.headers["authorization"] == "Bearer synthetic-tavily-key"
        assert body["include_raw_content"] is True and body["max_results"] == 5
        assert "wenku.baidu.com" in body["exclude_domains"]
        return httpx.Response(200, json={"results": [
            {"title": "t", "url": "https://x.example.com/a", "content": "摘要", "raw_content": "完整正文"},
        ]})

    hits = asyncio.run(ps.TavilyProvider("synthetic-tavily-key", httpx.MockTransport(handle)).search("q", 5))
    assert hits[0].content == "完整正文" and hits[0].snippet == "摘要"


def test_missing_keys_skip_paid_providers_but_anysearch_needs_no_key(monkeypatch):
    for name in ("VOLC_SEARCH_API_KEY", "TAVILY_API_KEY", "ANYSEARCH_API_KEY"):
        monkeypatch.setattr(ps, "_env", lambda key, _unused=name: "")
    ctx = SimpleNamespace(library=None, student_id="s1")
    providers, scope = ps.default_providers(ctx, ps.SearchGoodProblemsInput(knowledge_point=KP))
    assert [provider.name for provider in providers] == ["anysearch"] and providers[0].api_key == "" and scope == ""
    monkeypatch.setattr(ps, "_env", lambda key: "tavily-key" if key == "TAVILY_API_KEY" else "")
    providers, _ = ps.default_providers(ctx, ps.SearchGoodProblemsInput(knowledge_point=KP))
    assert [provider.name for provider in providers] == ["tavily", "anysearch"]


def test_anysearch_works_without_a_key_and_sends_one_when_given():
    seen = []

    def handle(request):
        seen.append(request.headers.get("authorization"))
        body = json.loads(request.content)
        assert body["query"] == "栈和队列" and body["max_results"] == 3 and body["language"] == "zh-CN" and body["format"] == "markdown"
        return httpx.Response(200, json={"code": 0, "message": "success", "data": {"results": [
            {"title": "栈和队列的区别", "url": "https://blog.example.com/a", "snippet": "后进先出与先进先出", "content": "x"},
            {"title": "坏链接", "url": "javascript:alert(1)", "snippet": "x"},
            {"title": "带密码", "url": "https://user:pw@example.com/a", "snippet": "x"},
            "not-a-row",
        ]}})

    anonymous = asyncio.run(ps.AnySearchProvider("", httpx.MockTransport(handle)).search("栈和队列", 3))
    assert seen == [None] and [hit.url for hit in anonymous] == ["https://blog.example.com/a"]
    assert anonymous[0].snippet == "后进先出与先进先出" and anonymous[0].content == "x"
    assert anonymous[0].provider == "anysearch" and anonymous[0].site == "blog.example.com"
    asyncio.run(ps.AnySearchProvider("synthetic-any-key", httpx.MockTransport(handle)).search("栈和队列", 3))
    assert seen[-1] == "Bearer synthetic-any-key"


@pytest.mark.parametrize("response,reason", [
    (httpx.Response(200, json={"code": 1, "message": "error"}), "provider"),
    (httpx.Response(200, json={"code": 0, "data": {"results": "nope"}}), "format"),
    (httpx.Response(200, text="<html>"), "format"),
    (httpx.Response(402, json={}), "quota"),
    (httpx.Response(429, json={}), "quota"),
    (httpx.Response(500, json={}), "http"),
])
def test_anysearch_failures_are_classified_not_raised_as_raw_errors(response, reason):
    with pytest.raises(ps.SearchFailure) as error:
        asyncio.run(ps.AnySearchProvider("", httpx.MockTransport(lambda _: response)).search("q", 3))
    assert error.value.kind == reason


def test_lecture_provider_maps_library_results():
    class Library:
        def search_scoped(self, student_id, query, limit, subject_id):
            assert (student_id, subject_id) == ("s1", "sub1")
            return [SourceReference(id="src1", document_id="doc1", title="第3章 定积分.pdf", label="资料1",
                                    page=12, excerpt=PAGE)]

    hits = asyncio.run(ps.LocalLectureProvider(Library(), "s1", "sub1").search(KP, 3))
    assert hits[0].origin == "lecture" and hits[0].url is None and hits[0].page == 12
    candidate, reason = build(PROBLEM_2, ps.Page(hits[0], ps.normalize_text(hits[0].content)))
    assert reason is None and candidate["source"]["origin_type"] == "讲义例题" and candidate["source"]["page"] == 12


def test_fuse_blocks_hosts_and_caps_sites():
    def hit(url):
        return ps.RawHit(url=url, title="t", site="s")
    lists = [[hit("https://wenku.baidu.com/view/1"), hit("https://a.example.com/1"), hit("https://a.example.com/2")],
             [hit("https://a.example.com/3"), hit("https://a.example.com/1/")]]
    stats = Counter()
    fused = ps.fuse(lists, stats)
    assert [h.url for h in fused] == ["https://a.example.com/1", "https://a.example.com/3"]
    assert stats["blocked_host"] == 1 and stats["site_cap"] == 1


# ------------------------------------------------------------ 抓取与 SSRF

async def public_resolver(host):
    return {"good.example.com": ["93.184.216.34"], "evil.example.com": ["192.168.1.10"]}.get(host, [])


@pytest.mark.parametrize("url,expected", [
    ("https://good.example.com/a", True),
    ("https://evil.example.com/a", False),      # 域名解析到内网
    ("http://127.0.0.1/", False),
    ("http://10.0.0.8/admin", False),
    ("http://169.254.169.254/latest/meta-data", False),
    ("http://[::1]/", False),
    ("http://localhost/", False),
    ("https://good.example.com:8080/", False),  # 非标准端口
    ("javascript:alert(1)", False),
    ("file:///etc/passwd", False),
    ("https://user:pw@good.example.com/", False),
    ("https://unknown.example.com/", False),    # 解析失败
])
def test_fetcher_rejects_internal_targets(url, expected):
    assert asyncio.run(ps.PageFetcher(resolver=public_resolver).allowed(url)) is expected


def test_redirect_to_metadata_service_is_blocked():
    requests = []

    def handle(request):
        requests.append(str(request.url))
        return httpx.Response(302, headers={"location": "http://169.254.169.254/latest/meta-data"})

    fetcher = ps.PageFetcher(transport=httpx.MockTransport(handle), resolver=public_resolver)
    assert asyncio.run(fetcher.fetch("https://good.example.com/a")) is None
    assert requests == ["https://good.example.com/a"]


def test_fetch_follows_safe_redirect_and_limits_size():
    def handle(request):
        if request.url.path == "/old":
            return httpx.Response(301, headers={"location": "/new"})
        if request.url.path == "/big":
            return httpx.Response(200, headers={"content-type": "text/html"}, content=b"x" * 5000)
        if request.url.path == "/pdf":
            return httpx.Response(200, headers={"content-type": "application/pdf"}, content=b"%PDF")
        return httpx.Response(200, headers={"content-type": "text/html; charset=gbk"},
                              content="<p>定积分</p>".encode("gbk"))

    fetcher = ps.PageFetcher(transport=httpx.MockTransport(handle), resolver=public_resolver, max_bytes=1000)
    assert "定积分" in asyncio.run(fetcher.fetch("https://good.example.com/old"))
    assert asyncio.run(fetcher.fetch("https://good.example.com/big")) is None
    assert asyncio.run(fetcher.fetch("https://good.example.com/pdf")) is None


def test_extract_fallback_when_direct_fetch_fails():
    def page(_request):
        return httpx.Response(521)

    def extract(request):
        assert str(request.url) == "https://api.anysearch.com/v1/extract"
        assert request.headers.get("authorization") is None
        assert json.loads(request.content) == {"url": "https://good.example.com/a"}
        text = "定积分换元法讲解。" * 20 + " ![](https://www.zhihu.com/equation?tex=x%5E2)"
        return httpx.Response(200, json={"code": 0, "data": {"content": text, "title": "t"}})

    fetcher = ps.PageFetcher(transport=httpx.MockTransport(page), resolver=public_resolver,
                              extract=ps.AnySearchExtractor("", httpx.MockTransport(extract)))
    hit = ps.RawHit(url="https://good.example.com/a", title="t", site="good.example.com")
    stats = Counter()
    pages = asyncio.run(ps.load_pages([hit], fetcher, stats))
    assert len(pages) == 1 and "$x^2$" in pages[0].text and pages[0].link_density is None
    assert stats["extracted"] == 1 and "fetch_failed" not in stats


@pytest.mark.parametrize("response", [
    httpx.Response(422, json={"code": -1, "message": "Unable to extract content from the URL."}),
    httpx.Response(200, json={"code": -1, "data": {"content": "定积分" * 40}}),
    httpx.Response(200, json={"code": 0, "data": {"content": 9}}),
])
def test_extract_failure_counts_as_fetch_failed(response):
    fetcher = ps.PageFetcher(transport=httpx.MockTransport(lambda _request: httpx.Response(521)),
                              resolver=public_resolver,
                              extract=ps.AnySearchExtractor("", httpx.MockTransport(lambda _request: response)))
    hit = ps.RawHit(url="https://good.example.com/a", title="t", site="good.example.com")
    stats = Counter()
    assert asyncio.run(ps.load_pages([hit], fetcher, stats)) == []
    assert stats["fetch_failed"] == 1 and "extracted" not in stats


def test_extract_is_not_sent_to_blocked_urls():
    calls = []

    def extract(request):
        calls.append(str(request.url))
        return httpx.Response(200, json={"code": 0, "data": {"content": "定积分" * 40}})

    fetcher = ps.PageFetcher(transport=httpx.MockTransport(lambda _request: httpx.Response(200)),
                              resolver=public_resolver,
                              extract=ps.AnySearchExtractor("", httpx.MockTransport(extract)))
    hit = ps.RawHit(url="https://evil.example.com/a", title="t", site="evil.example.com")
    stats = Counter()
    assert asyncio.run(ps.load_pages([hit], fetcher, stats)) == []
    assert calls == [] and stats["fetch_failed"] == 1


# ------------------------------------------------------------ 公式还原

def test_mathjax_v2_source_kept_and_render_dropped():
    html = ('<html><body><p>计算 <span class="MathJax">渲染副本</span>'
            '<script type="math/tex">\\int_0^1 x^2 dx</script> 的值。</p>'
            '<script type="math/tex; mode=display">\\sum_{n=1}^\\infty \\frac{1}{n^2}</script></body></html>')
    text, _, lost = ps.html_to_text(html)
    assert "$\\int_0^1 x^2 dx$" in text and "$$\\sum_{n=1}^\\infty \\frac{1}{n^2}$$" in text
    assert "渲染副本" not in text and lost == 0


def test_katex_mathml_and_formula_images():
    html = ('<html><body><p>由 <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mn>1</mn></mrow>'
            '<annotation encoding="application/x-tex">\\frac{1}{2}</annotation></semantics></math></span>'
            '<span class="katex-html">渲染副本</span></span> 可知，'
            '<math alttext="x^2+1"><mi>x</mi></math>，'
            '<img class="ee_img tex" src="https://www.zhihu.com/equation?tex=%5Csqrt%7Bx%7D" alt="\\sqrt{x}">，'
            '<img class="math" src="https://cdn.example.com/formula/1.png"></p></body></html>')
    text, _, lost = ps.html_to_text(html)
    assert "$\\frac{1}{2}$" in text and "$x^2+1$" in text and "$\\sqrt{x}$" in text
    assert "渲染副本" not in text and lost == 1  # 最后一张公式图片既没有源码也没有 alt


def test_mathjax_v3_assistive_mathml():
    html = ('<html><body><p>求 <mjx-container class="MathJax"><mjx-math>渲染</mjx-math>'
            '<mjx-assistive-mml><math alttext="e^{x}"><mi>e</mi></math></mjx-assistive-mml></mjx-container> 的导数</p></body></html>')
    text, _, _ = ps.html_to_text(html)
    assert "$e^{x}$" in text and "渲染" not in text


def test_markdown_formula_images_and_delimiters():
    text, lost = ps.restore_markdown_formulas("求 ![](https://www.zhihu.com/equation?tex=x%5E2) 的导数 ![](https://cdn.example.com/math/2.png)")
    assert "$x^2$" in text and lost == 1
    assert ps.normalize_text("已知\\(a+b\\)与\\[c\u200b\\]") == "已知$a+b$与$$c$$"


# ------------------------------------------------------------ 低质过滤

@pytest.mark.parametrize("text,title,reason", [
    ("关注公众号领取资料包！扫码加群。" * 20, "定积分", "spam"),
    (PAGE + "\n剩余内容 VIP可见，开通会员后查看。", "定积分", "paywall"),
    (PAGE, "震惊！99%的人都做错的押题", None),        # 只有标题党不足以判死刑，正文干净
    ("短", "定积分", "too_short"),
])
def test_low_quality_rules(text, title, reason):
    pg = ps.Page(ps.RawHit(url="https://x.example.com/", title=title, site="x"), text)
    assert ps.low_quality_reason(pg) == reason


def test_link_farm_and_formula_images():
    farm = ps.Page(ps.RawHit(url="https://x.example.com/", title="t", site="x"), PAGE, link_density=0.8)
    pictures = ps.Page(ps.RawHit(url="https://x.example.com/", title="t", site="x"), "题目" * 100, lost_formulas=5)
    assert ps.low_quality_reason(farm) == "link_farm"
    assert ps.low_quality_reason(pictures) == "formula_images"


# ------------------------------------------------------------ 完整性与溯源

def test_valid_problems_become_candidates():
    calc, reason = build(PROBLEM_1)
    assert reason is None
    assert calc["type"] == "计算" and calc["answer_index"] is None
    assert calc["source"]["origin_type"] == "考研真题" and calc["source"]["exam_tag"] == "2019 考研数学一"
    assert calc["candidate_id"] == "cand_" + calc["fingerprint"][:12]

    choice, reason = build(PROBLEM_2)
    assert reason is None
    assert choice["options"][0] == "$\\int_0^1 f(x)dx$" and choice["answer_index"] == 0
    assert choice["source"]["origin_type"] == "经典母题"


@pytest.mark.parametrize("change,reason", [
    ({"answer": None}, "no_answer"),
    ({"solution": "略"}, "no_solution"),
    ({"stem": "如图所示，计算阴影部分的面积，其中曲线为抛物线。"}, "needs_figure"),
    ({"has_figure": True}, "needs_figure"),
    ({"solution": PROBLEM_1["solution"][:40] + "..."}, "truncated"),
    ({"stem": "计算定积分 $\\int_0^4 \\frac{dx}{1+\\sqrt{x}$。"}, "latex_unbalanced"),
    ({"stem": "计算定积分 $\\int_0^1 \\frac{dx}{1+x^2}$ 的值。"}, "not_in_source"),   # 编造的题干
    ({"stem": "计算定积分 $\\int_0^9 \\frac{dx}{1+\\sqrt{x}}$。"}, "not_in_source"),  # 只改了一个数字
    ({"answer": "$4-2\\ln 5$"}, "not_in_source"),                                  # 答案被改
])
def test_incomplete_or_untraceable_problems_dropped(change, reason):
    assert build({**PROBLEM_1, **change}) == (None, reason)


@pytest.mark.parametrize("change,reason", [
    ({"answer": "D", "options": PROBLEM_2["options"][:3]}, "answer_not_in_options"),
    ({"options": ["A. $1$"]}, "bad_options"),
    ({"options": ["A. 1", "B. 1"]}, "bad_options"),
    ({"options": ["A. $\\int_0^1 f(x)dx$", "B. $-\\int_0^2 f(x)dx$"]}, "not_in_source"),  # 选项被改
])
def test_choice_checks(change, reason):
    assert build({**PROBLEM_2, **change}) == (None, reason)


def test_missing_choice_answer_recovered_from_solution():
    candidate, reason = build({**PROBLEM_2, "answer": None})
    assert reason is None and candidate["answer"] == "A" and candidate["answer_index"] == 0
    # 解析里同时出现两个不同选项字母时不猜
    assert build({**PROBLEM_2, "answer": None, "solution": PROBLEM_2["solution"].replace("选 A", "选 A 或选 B")})[1] == "no_answer"


def test_public_candidate_carries_quiz_placeholder():
    choice, _ = build(PROBLEM_2)
    calc, _ = build(PROBLEM_1)
    assert ps.public_candidate(choice)["quiz"] == f"[[quiz:{choice['candidate_id']}]]"
    assert ps.public_candidate(calc)["quiz"] is None  # 计算题要先配选项校验


def test_stem_header_line_stripped():
    header = "2019 年全国硕士研究生入学统一考试 数学一 真题解析\n"
    candidate, reason = build({**PROBLEM_2, "stem": header + PROBLEM_2["stem"]})
    assert reason is None and candidate["stem"] == PROBLEM_2["stem"]
    # 题目本身的首行（含「设」「计算」等）不删；只有一行时也不动
    multi = "设 $f(x)$ 连续，\n则 $\\int_0^1 f(1-x)dx$ 等于（ ）"
    assert ps.strip_stem_header(multi, page()) == multi
    assert ps.strip_stem_header("2019 年真题解析", page()) == "2019 年真题解析"


def test_options_without_dollars_are_wrapped():
    bare = ["\\int_0^1 f(x)dx", "-\\int_0^1 f(x)dx", "2\\int_0^1 f(x)dx", "0"]
    candidate, reason = build({**PROBLEM_2, "options": bare})
    assert reason is None
    assert candidate["options"] == ["$\\int_0^1 f(x)dx$", "$-\\int_0^1 f(x)dx$", "$2\\int_0^1 f(x)dx$", "0"]
    assert candidate["answer_index"] == 0


def test_exam_tag_must_appear_in_source():
    candidate, _ = build({**PROBLEM_1, "exam_tag": "2021 考研数学二"})
    assert candidate["exam_tag"] is None and candidate["source"]["origin_type"] == "经典母题"


def test_irrelevant_problem_dropped():
    raw = {**PROBLEM_1, "knowledge_points": []}
    assert ps.build_candidate(raw, page(), "二叉树遍历", "2026-10-20") == (None, "irrelevant")


# ------------------------------------------------------------ 去重

def test_same_problem_different_layout_same_fingerprint():
    a = ps.fingerprint("计算定积分 $\\int_0^4 \\frac{dx}{1+\\sqrt{x}}$。")
    b = ps.fingerprint("计算定积分\\(\\int_{0}^{4}\\dfrac{dx}{1+\\sqrt{x}}\\).")
    assert a == b


def test_changed_number_is_not_merged():
    one, _ = build(PROBLEM_1)
    other = dict(one, fingerprint=one["fingerprint"],
                 _numbers=ps.numbers_signature("计算定积分 $\\int_0^9 \\frac{dx}{1+\\sqrt{x}}$。"))
    assert ps.same_problem(one, dict(one)) and not ps.same_problem(one, other)
    stats = Counter()
    assert len(ps.merge_duplicates([one, other], stats)) == 2 and stats["duplicate"] == 0


# ------------------------------------------------------------ 端到端（全部注入）

class StubProvider:
    name = "stub"

    def __init__(self, hits=None, error=None):
        self.hits, self.error, self.queries = hits or [], error, []

    async def search(self, query, k):
        self.queries.append(query)
        if self.error:
            raise self.error
        return list(self.hits)


class StubFetcher:
    def __init__(self):
        self.calls = []

    async def fetch(self, url):
        self.calls.append(url)
        return None


def stub_extractor(calls, problems=(PROBLEM_1, PROBLEM_2)):
    async def extract(messages):
        payload = json.loads(messages[1]["content"])
        calls.append(payload["page_url"])
        assert "忽略" in messages[0]["content"]  # 防注入规则在 system prompt 里
        return {"problems": list(problems) if "例1" in payload["page_text"] else []}
    return extract


def web_hits():
    def hit(url, content, title="定积分换元法真题"):
        return ps.RawHit(url=url, title=title, site=url.split("/")[2], content=content)
    return [
        hit("https://math.a.edu.cn/kaoyan/2019", PAGE, "2019 考研数学一 定积分真题"),
        hit("https://b.example.com/copy", PAGE),
        hit("https://c.example.com/spam", "关注公众号领取资料包！扫码加群。" * 30),
        hit("https://d.example.com/paid", PAGE.replace("例1", "例3") + "\n剩余内容 VIP可见"),
        hit("https://wenku.baidu.com/view/1", PAGE),
    ]


def test_pipeline_end_to_end():
    calls, fetcher = [], StubFetcher()
    provider = StubProvider(web_hits())
    result = asyncio.run(ps.search_good_problems(
        {"knowledge_point": KP, "count": 2}, None, providers=[provider], fetcher=fetcher,
        extractor=stub_extractor(calls)))

    assert result["status"] == "ok" and len(result["candidates"]) == 2
    assert len(provider.queries) == 2
    assert sorted(calls) == ["https://b.example.com/copy", "https://math.a.edu.cn/kaoyan/2019"]  # 营销页、付费页没送去抽题
    assert fetcher.calls == []  # provider 已给正文，不再抓取
    stats = result["dropped_stats"]
    assert stats["spam"] == 1 and stats["paywall"] == 1 and stats["blocked_host"] >= 1 and stats["duplicate"] == 2
    for candidate in result["candidates"]:
        assert candidate["source"]["url"] == "https://math.a.edu.cn/kaoyan/2019"  # 镜像合并后保留最可信来源
        assert candidate["source"]["retrieved_at"]
        assert not any(key.startswith("_") for key in candidate)
        assert ps.lookup_candidate(candidate["candidate_id"])["stem"] == candidate["stem"]
    assert result["candidates"][0]["exam_tag"] == "2019 考研数学一"  # 有出处的真题排在前面


def test_exclude_fingerprints_and_type_filter():
    first = asyncio.run(ps.search_good_problems(
        {"knowledge_point": KP}, None, providers=[StubProvider(web_hits())], fetcher=StubFetcher(),
        extractor=stub_extractor([])))
    shown = [c["fingerprint"] for c in first["candidates"]]
    again = asyncio.run(ps.search_good_problems(
        {"knowledge_point": KP, "exclude_fingerprints": shown[:1]}, None, providers=[StubProvider(web_hits())],
        fetcher=StubFetcher(), extractor=stub_extractor([])))
    assert shown[0] not in [c["fingerprint"] for c in again["candidates"]] and again["dropped_stats"]["excluded"] == 1
    only_choice = asyncio.run(ps.search_good_problems(
        {"knowledge_point": KP, "problem_types": ["选择"]}, None, providers=[StubProvider(web_hits())],
        fetcher=StubFetcher(), extractor=stub_extractor([])))
    assert [c["type"] for c in only_choice["candidates"]] == ["选择"]


def test_failing_provider_degrades_to_partial():
    providers = [StubProvider(error=ps.SearchFailure("auth")), StubProvider(error=RuntimeError("boom")),
                 StubProvider(web_hits())]
    providers[0].name, providers[1].name = "volcengine", "tavily"
    result = asyncio.run(ps.search_good_problems(
        {"knowledge_point": KP, "count": 2}, None, providers=providers, fetcher=StubFetcher(),
        extractor=stub_extractor([])))
    assert result["status"] == "partial" and len(result["candidates"]) == 2
    assert result["provider_errors"] == {"volcengine:auth": 2, "tavily:error": 2}


def test_fabricating_extractor_yields_no_result():
    invented = {**PROBLEM_1, "stem": "计算定积分 $\\int_0^1 \\frac{dx}{1+x^2}$ 的值。"}
    result = asyncio.run(ps.search_good_problems(
        {"knowledge_point": KP}, None, providers=[StubProvider(web_hits())], fetcher=StubFetcher(),
        extractor=stub_extractor([], [invented])))
    assert result["status"] == "no_result" and result["candidates"] == []
    # 两个页面各抽一次、各重抽一次，四次都被溯源校验拦下
    assert result["dropped_stats"]["not_in_source"] == 4 and result["dropped_stats"]["extract_retry"] == 2
    assert "不要自行编造" in result["note"]


def test_page_with_only_garbled_problems_is_extracted_again():
    calls = []
    garbled = {**PROBLEM_1, "stem": "计算定积分 $∫_0^4 㰍x/√x+1$。"}

    async def flaky(messages):
        calls.append(1)
        return {"problems": [garbled] if len(calls) == 1 else [PROBLEM_1, PROBLEM_2]}

    hit = ps.RawHit(url="https://math.a.edu.cn/kaoyan/2019", title="2019 考研数学一 定积分真题",
                    site="a.edu.cn", content=PAGE)
    result = asyncio.run(ps.search_good_problems(
        {"knowledge_point": KP}, None, providers=[StubProvider([hit])], fetcher=StubFetcher(), extractor=flaky))
    assert len(calls) == 2 and result["dropped_stats"]["extract_retry"] == 1
    assert len(result["candidates"]) == 2


def test_page_without_problems_is_not_retried():
    calls = []

    async def empty(messages):
        calls.append(1)
        return {"problems": []}

    hit = ps.RawHit(url="https://math.a.edu.cn/kaoyan/2019", title="t", site="a.edu.cn", content=PAGE)
    result = asyncio.run(ps.search_good_problems(
        {"knowledge_point": KP}, None, providers=[StubProvider([hit])], fetcher=StubFetcher(), extractor=empty))
    assert len(calls) == 1 and "extract_retry" not in result["dropped_stats"]


def test_no_sources_configured():
    result = asyncio.run(ps.search_good_problems({"knowledge_point": KP}, None, providers=[],
                                                 extractor=stub_extractor([])))
    assert result["status"] == "no_result" and "VOLC_SEARCH_API_KEY" in result["note"]


# ------------------------------------------------------------ 工具入口

def test_run_never_raises(monkeypatch):
    ctx = SimpleNamespace(student_id="s1", library=None, model=None)
    assert json.loads(asyncio.run(ps.run({"knowledge_point": KP}, ctx)))["status"] == "no_result"
    assert json.loads(asyncio.run(ps.run({}, ctx)))["status"] == "invalid_arguments"
    assert json.loads(asyncio.run(ps.run({"knowledge_point": 123}, ctx)))["status"] == "invalid_arguments"

    async def boom(arguments, ctx):
        raise httpx.ConnectError("private")
    monkeypatch.setattr(ps, "search_good_problems", boom)
    result = json.loads(asyncio.run(ps.run({"knowledge_point": KP}, ctx)))
    assert result["status"] == "no_result" and result["dropped_stats"] == {"internal_error": 1}


def test_render_trims_solutions_but_never_stems():
    def candidate(i, stem_len, solution_len):
        return {"candidate_id": f"c{i}", "stem": "题" * stem_len, "options": None, "answer": "1",
                "solution": "解" * solution_len}

    short = {"status": "ok", "candidates": [candidate(i, 300, 3000) for i in range(5)]}
    text = ps.render(short)
    data = json.loads(text)
    assert len(text) <= ps.OUTPUT_BUDGET and len(data["candidates"]) == 5
    assert all(c["stem"] == "题" * 300 and c["solution"].endswith("…") for c in data["candidates"])

    long = {"status": "ok", "candidates": [candidate(i, 2500, 100) for i in range(5)]}
    text = ps.render(long)
    data = json.loads(text)
    assert len(text) <= ps.OUTPUT_BUDGET and 0 < len(data["candidates"]) < 5
    assert all(c["stem"] == "题" * 2500 for c in data["candidates"])


def test_definition_is_well_formed():
    function = ps.DEFINITION["function"]
    assert function["name"] == ps.TOOL_NAME and function["parameters"]["required"] == ["knowledge_point"]
    assert set(function["parameters"]["properties"]) == set(ps.SearchGoodProblemsInput.model_fields)


def test_proxy_fake_ip_range_is_allowed_but_real_internal_addresses_are_not():
    # 开代理（fake-ip DNS）时所有域名都解析到 198.18.0.0/15；这不是内网，不能因此拒掉所有网页
    for address in ("198.18.0.1", "198.18.1.87", "198.19.255.254"):
        assert ps._public_ip(address) is True
    for address in ("127.0.0.1", "10.0.0.5", "172.16.3.4", "192.168.1.9", "169.254.169.254", "100.64.0.1",
                    "0.0.0.0", "::1", "fe80::1", "fc00::1", "not-an-ip"):
        assert ps._public_ip(address) is False, address
    # the exception is exactly 198.18.0.0/15; its neighbours keep the standard library's verdict (ordinary public)
    assert str(ps._PROXY_FAKE_IP) == "198.18.0.0/15" and ps._public_ip("198.17.255.255") and ps._public_ip("198.20.0.1")

    async def fake_ip_resolver(host):
        return ["198.18.1.87"]

    async def mixed_resolver(host):
        return ["198.18.1.87", "10.0.0.5"]

    async def check(resolver):
        return await ps.PageFetcher(resolver=resolver).allowed("https://blog.csdn.net/a/b")

    assert asyncio.run(check(fake_ip_resolver)) is True
    assert asyncio.run(check(mixed_resolver)) is False    # one internal answer still blocks the host

