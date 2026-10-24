"""Static HTML for the loopback OAuth callback (ChatGPT sign-in). No scripts: the CSP forbids them."""

import html

# Inlined so the page works from the frozen backend and offline; CSP only allows inline styles.
_LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" fill="none"><defs><linearGradient id="pillarGrad" x1="150" y1="140" x2="360" y2="884" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#60A5FA"/><stop offset="45%" stop-color="#3B82F6"/><stop offset="100%" stop-color="#1D4ED8"/></linearGradient><linearGradient id="upperWing" x1="520" y1="450" x2="880" y2="150" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#38BDF8"/><stop offset="50%" stop-color="#3B82F6"/><stop offset="100%" stop-color="#1D4ED8"/></linearGradient><linearGradient id="lowerWing" x1="520" y1="574" x2="880" y2="874" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#38BDF8"/><stop offset="55%" stop-color="#2563EB"/><stop offset="100%" stop-color="#1E3A8A"/></linearGradient><linearGradient id="prismCore" x1="400" y1="400" x2="580" y2="624" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#67E8F9"/><stop offset="50%" stop-color="#38BDF8"/><stop offset="100%" stop-color="#2563EB"/></linearGradient><linearGradient id="prismInner" x1="440" y1="450" x2="530" y2="574" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#FFFFFF"/><stop offset="100%" stop-color="#BAE6FD"/></linearGradient><linearGradient id="rimLight" x1="140" y1="140" x2="880" y2="880" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#93C5FD" stop-opacity="0.55"/><stop offset="50%" stop-color="#60A5FA" stop-opacity="0.2"/><stop offset="100%" stop-color="#1E3A8A" stop-opacity="0.15"/></linearGradient></defs><!-- 1. Left Pillar (Known Foundation) with clean V-notch facing the central gap --><path d="M 156 214\n               C 156 164 210 134 253 160\n               L 336 210\n               C 356 222 368 244 368 268\n               L 368 386\n               C 368 402 361 417 349 427\n               L 270 492\n               C 256 503 256 521 270 532\n               L 349 597\n               C 361 607 368 622 368 638\n               L 368 756\n               C 368 780 356 802 336 814\n               L 253 864\n               C 210 890 156 860 156 810\n               Z"\n            fill="url(#pillarGrad)"\n            stroke="url(#rimLight)"\n            stroke-width="4"/><!-- 2. Upper Right Wing (Clean 36px gap above the central prism) --><path d="M 552 344\n               L 774 158\n               C 813 125 872 153 872 204\n               L 872 342\n               C 872 367 861 391 842 407\n               L 682 542\n               C 661 560 630 558 611 538\n               L 548 470\n               C 516 436 518 373 552 344\n               Z"\n            transform="translate(18, -56)"\n            fill="url(#upperWing)"\n            stroke="url(#rimLight)"\n            stroke-width="4"/><!-- 3. Lower Right Wing (Clean mirror symmetry below the central prism) --><path d="M 552 680\n               L 774 866\n               C 813 899 872 871 872 820\n               L 872 682\n               C 872 657 861 633 842 617\n               L 682 482\n               C 661 464 630 466 611 486\n               L 548 554\n               C 516 588 518 651 552 680\n               Z"\n            transform="translate(18, 56)"\n            fill="url(#lowerWing)"\n            stroke="url(#rimLight)"\n            stroke-width="4"/><!-- 4. Central Faceted Diamond Prism (The "知隙" Spark bridging the gap, zero overlap) --><path d="M 468 386\n               C 476 374 492 374 500 386\n               L 584 496\n               C 593 508 593 516 584 528\n               L 500 638\n               C 492 650 476 650 468 638\n               L 384 528\n               C 375 516 375 508 384 496\n               Z"\n            fill="url(#prismCore)"\n            stroke="url(#rimLight)"\n            stroke-width="4"/><!-- Crisp 4-point inner star highlight inside the prism --><path d="M 484 434\n               C 491 478 510 497 554 512\n               C 510 527 491 546 484 590\n               C 477 546 458 527 414 512\n               C 458 497 477 478 484 434\n               Z"\n            fill="url(#prismInner)"/></svg>'

_STYLE = """
:root{color-scheme:light dark;--bg:#f7f8fa;--card:#fff;--border:rgb(15 23 42 / 8%);--text:#0f172a;--muted:#5b6475;
--accent:#3b82f6;--accent-soft:rgb(59 130 246 / 12%);--bad:#dc2626;--bad-soft:rgb(220 38 38 / 10%);
--chip:#f1f3f7;--shadow:0 1px 2px rgb(15 23 42 / 4%),0 12px 40px rgb(15 23 42 / 8%)}
@media (prefers-color-scheme:dark){:root{--bg:#08080a;--card:#111216;--border:rgb(255 255 255 / 8%);--text:#f3f4f6;
--muted:#9aa3b2;--accent:#4f80f5;--accent-soft:rgb(79 128 245 / 16%);--bad:#f87171;--bad-soft:rgb(248 113 113 / 14%);
--chip:#1a1c22;--shadow:0 0 0 1px rgb(255 255 255 / 3%),0 20px 60px rgb(0 0 0 / 55%)}}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);
font:15px/1.65 system-ui,-apple-system,"Segoe UI","Microsoft YaHei UI","Microsoft YaHei",sans-serif;
background-image:radial-gradient(60% 50% at 50% 0%,var(--accent-soft),transparent 70%);-webkit-font-smoothing:antialiased}
main{width:min(420px,100%);padding:40px 36px 32px;border:1px solid var(--border);border-radius:18px;background:var(--card);
box-shadow:var(--shadow);text-align:center;animation:rise 360ms cubic-bezier(.2,.8,.2,1) both}
.brand{display:inline-flex;align-items:center;gap:8px;margin-bottom:28px;color:var(--muted);font-size:13px;font-weight:600;letter-spacing:.02em}
.brand svg{width:22px;height:22px}
.badge{display:grid;place-items:center;width:64px;height:64px;margin:0 auto 20px;border-radius:50%;
background:var(--accent-soft);color:var(--accent)}
.badge.bad{background:var(--bad-soft);color:var(--bad)}
.badge svg{width:30px;height:30px}
h1{margin:0 0 8px;font-size:22px;line-height:1.3;font-weight:650;letter-spacing:-.01em}
p{margin:0}
.msg{color:var(--muted);overflow-wrap:anywhere}
.hint{display:inline-block;margin-top:24px;padding:8px 14px;border-radius:999px;background:var(--chip);color:var(--muted);font-size:13px}
@keyframes rise{from{opacity:0;transform:translateY(8px)}}
@media (prefers-reduced-motion:reduce){main{animation:none}}
@media (max-width:420px){main{padding:32px 22px 26px}}
"""

_OK_ICON = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" '
            'stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>')
_BAD_ICON = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" '
             'stroke-linejoin="round" aria-hidden="true"><path d="M12 7v6"/><path d="M12 17h.01"/></svg>')


def render_oauth_page(ok: bool, message: str) -> bytes:
    title = "授权完成" if ok else "授权未完成"
    hint = "现在可以关闭此页面，回到 KnowGap" if ok else "请回到 KnowGap 重新连接"
    badge = "badge" if ok else "badge bad"
    icon = _OK_ICON if ok else _BAD_ICON
    return (
        "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<meta name='color-scheme' content='light dark'>"
        f"<title>{title} · KnowGap</title><style>{_STYLE}</style></head><body>"
        f"<main role='status'><div class='brand'>{_LOGO}<span>KnowGap</span></div>"
        f"<div class='{badge}'>{icon}</div><h1>{title}</h1><p class='msg'>{html.escape(message)}</p>"
        f"<p class='hint'>{hint}</p></main></body></html>"
    ).encode("utf-8")
