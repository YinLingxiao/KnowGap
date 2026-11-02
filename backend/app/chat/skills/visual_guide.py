"""Sandbox visual-card guide (`knowgap-visual`) injected into thread skills."""

VISUAL_CARD_GUIDE = """【沙箱可视化卡规范（`knowgap-visual`）】
代码块正文是一段 HTML 片段，渲染在隔离的 iframe 中。
1. 何时使用：结构图（二叉树/链表/图）、遍历或过程动画、占比和数据图、滑块实时计算器用 `knowgap-visual`。测验、对比表、步骤推演、代码实验用 `knowgap-widget`。纯文字能说清时两者都不用。需要服务端记录状态的（判分、学习证据）不用 visual。
2. 写法：只写内容片段，不写 <html>/<head>/<body>。颜色只用宿主 CSS 变量：var(--bg)、var(--bg-elevated)、var(--bg-subtle)、var(--text)、var(--text-secondary)、var(--text-tertiary)、var(--border)、var(--border-strong)、var(--accent)、var(--accent-soft)、var(--accent-text)、var(--green)、var(--green-soft)、var(--orange)、var(--orange-soft)、var(--font-sans)、var(--font-mono)、var(--radius)、var(--radius-lg)，深浅色都必须可读。扁平，无渐变、阴影、发光。字号 ≥12px，字重只用 400/500/600。只用原生 SVG/Canvas/DOM，不加载任何外部资源（脚本、样式、图片、字体、fetch 都会被拦截，桌面端可能离线）。交互需要追问时调用 knowgap.ask("…")。宽度自适应容器（width:100%，SVG 用 viewBox + width="100%"），不用 fixed 定位。内容简短，一张卡只讲一个点。
3. 二叉树：SVG 画约 7 个节点和连线；前序/中序/后序按钮用定时器逐个点亮，圆旁数字是访问次序。
```knowgap-visual
<style>
button{margin:0 6px 0 0;padding:4px 10px;font:500 13px var(--font-sans);color:var(--text);background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius)}
svg text{font-size:12px;font-weight:500;font-family:var(--font-sans);text-anchor:middle}
</style>
<svg viewBox="0 0 300 168" width="100%">
<g stroke="var(--border-strong)" stroke-width="1.5">
<line x1="150" y1="36" x2="78" y2="86"/><line x1="150" y1="36" x2="222" y2="86"/><line x1="78" y1="86" x2="40" y2="136"/><line x1="78" y1="86" x2="116" y2="136"/><line x1="222" y1="86" x2="184" y2="136"/><line x1="222" y1="86" x2="260" y2="136"/>
</g>
<g id="n1"><circle cx="150" cy="36" r="14" fill="var(--bg-elevated)" stroke="var(--border)"/><text class="v" x="150" y="40" fill="var(--text)">1</text><text class="o" x="168" y="30" fill="var(--accent)"></text></g>
<g id="n2"><circle cx="78" cy="86" r="14" fill="var(--bg-elevated)" stroke="var(--border)"/><text class="v" x="78" y="90" fill="var(--text)">2</text><text class="o" x="96" y="80" fill="var(--accent)"></text></g>
<g id="n3"><circle cx="222" cy="86" r="14" fill="var(--bg-elevated)" stroke="var(--border)"/><text class="v" x="222" y="90" fill="var(--text)">3</text><text class="o" x="240" y="80" fill="var(--accent)"></text></g>
<g id="n4"><circle cx="40" cy="136" r="14" fill="var(--bg-elevated)" stroke="var(--border)"/><text class="v" x="40" y="140" fill="var(--text)">4</text><text class="o" x="58" y="130" fill="var(--accent)"></text></g>
<g id="n5"><circle cx="116" cy="136" r="14" fill="var(--bg-elevated)" stroke="var(--border)"/><text class="v" x="116" y="140" fill="var(--text)">5</text><text class="o" x="134" y="130" fill="var(--accent)"></text></g>
<g id="n6"><circle cx="184" cy="136" r="14" fill="var(--bg-elevated)" stroke="var(--border)"/><text class="v" x="184" y="140" fill="var(--text)">6</text><text class="o" x="202" y="130" fill="var(--accent)"></text></g>
<g id="n7"><circle cx="260" cy="136" r="14" fill="var(--bg-elevated)" stroke="var(--border)"/><text class="v" x="260" y="140" fill="var(--text)">7</text><text class="o" x="278" y="130" fill="var(--accent)"></text></g>
</svg>
<p style="margin:8px 0 0"><button type="button" data-o="pre">前序</button><button type="button" data-o="in">中序</button><button type="button" data-o="post">后序</button><button type="button" id="ask">追问这棵树</button></p>
<script>
(function () {
  var order = {pre:[1,2,4,5,3,6,7], in:[4,2,5,1,6,3,7], post:[4,5,2,6,7,3,1]}, timer = null;
  function paint(id, on, n) {
    var g = document.getElementById("n" + id);
    var c = g.querySelector("circle");
    c.setAttribute("fill", on ? "var(--accent-soft)" : "var(--bg-elevated)");
    c.setAttribute("stroke", on ? "var(--accent)" : "var(--border)");
    g.querySelector(".v").setAttribute("fill", on ? "var(--accent-text)" : "var(--text)");
    g.querySelector(".o").textContent = n || "";
  }
  function play(k) {
    if (timer) clearInterval(timer);
    var i, seq = order[k], step = 0;
    for (i = 1; i <= 7; i++) paint(i, false, "");
    timer = setInterval(function () {
      if (step >= seq.length) { clearInterval(timer); timer = null; return; }
      paint(seq[step], true, String(step + 1));
      step += 1;
    }, 420);
  }
  var j, bs = document.querySelectorAll("button[data-o]");
  for (j = 0; j < bs.length; j++) bs[j].addEventListener("click", function () { play(this.getAttribute("data-o")); });
  document.getElementById("ask").addEventListener("click", function () { knowgap.ask("按这棵树走一遍后序，为什么根节点最后才被访问？"); });
})();
</script>
```
4. 滑块计算器：命中率与缺失代价实时算出平均访存，两段色条表示命中耗时和缺失耗时的占比。
```knowgap-visual
<style>
label,p{display:block;margin:8px 0 4px;font:400 13px var(--font-sans);color:var(--text)}
input{width:100%}
.bar{display:flex;width:100%;height:14px;margin-top:6px;border-radius:var(--radius);overflow:hidden;background:var(--bg-subtle)}
.bar div{height:100%;flex:none}
</style>
<label>命中率 <span id="hp" style="font-weight:600">80</span>%</label>
<input id="h" type="range" min="0" max="100" value="80">
<label>缺失代价 <span id="mp" style="font-weight:600">50</span> 周期</label>
<input id="m" type="range" min="1" max="200" value="50">
<p id="out">平均访存</p>
<div class="bar"><div id="a" style="width:7.4%;background:var(--accent)"></div><div id="g" style="width:92.6%;background:var(--green)"></div></div>
<p style="color:var(--text-secondary);font-size:12px">左段是命中耗时占比，右段是缺失耗时占比；命中记 1 周期。</p>
<script>
(function () {
  var h = document.getElementById("h"), m = document.getElementById("m");
  function render() {
    var hv = +h.value, mv = +m.value;
    var hit = hv / 100, miss = (1 - hv / 100) * mv, total = hit + miss || 1;
    document.getElementById("hp").textContent = String(hv);
    document.getElementById("mp").textContent = String(mv);
    document.getElementById("out").textContent = "平均访存 " + (hit + miss).toFixed(1) + " 周期";
    document.getElementById("a").style.width = (hit / total * 100).toFixed(1) + "%";
    document.getElementById("g").style.width = (miss / total * 100).toFixed(1) + "%";
  }
  h.addEventListener("input", render);
  m.addEventListener("input", render);
  render();
})();
</script>
```
在 visual 卡前后用一两句文字说明看什么、怎么操作。"""
