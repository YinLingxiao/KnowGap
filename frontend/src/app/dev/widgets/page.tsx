"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/components/LanguageProvider";
import { Markdown } from "@/components/chat/Markdown";
import { fastForwardWidgets } from "@/lib/chat/smoothWidgets";

const fence = (language: string, body: string) => "```" + language + "\n" + body + "\n```";
const widget = (data: unknown) => fence("knowgap-widget", JSON.stringify(data));

const STEP = widget({
  type: "step_simulator", title: "入栈再出栈", subtitle: "看 top 指针怎么跟着移动",
  steps: [
    { label: "初始化空栈", detail: "数组还没放任何元素，top 记为 -1。", state: [{ key: "栈内容", value: "（空）" }, { key: "top", value: "-1" }, { key: "元素个数", value: "0" }] },
    { label: "压入 A", detail: "top 先加 1，再把 A 放到 top 指向的位置。", state: [{ key: "栈内容", value: "A" }, { key: "top", value: "0", highlight: true }, { key: "元素个数", value: "1" }] },
    { label: "压入 B", detail: "B 盖在 A 上面，现在栈顶是 B。", state: [{ key: "栈内容", value: "A, B" }, { key: "top", value: "1", highlight: true }, { key: "元素个数", value: "2" }] },
    { label: "弹出栈顶", detail: "取走 top 指向的 B，top 减 1；A 重新成为栈顶。", state: [{ key: "栈内容", value: "A" }, { key: "top", value: "0", highlight: true }, { key: "元素个数", value: "1" }] },
  ],
});

const COMPARE = widget({
  type: "comparison_matrix", title: "栈和队列差在哪", subtitle: "都是线性表，区别只在从哪一头取",
  columns: ["栈", "队列"],
  rows: [
    { dimension: "取出顺序", values: ["后进先出（LIFO）", "先进先出（FIFO）"], takeaway: "只看「先取谁」就能分清两者" },
    { dimension: "操作位置", values: ["进出都在栈顶", "队尾进、队头出"] },
    { dimension: "生活里的例子", values: ["一摞盘子，只能拿最上面的", "排队买票，先来先买"] },
    { dimension: "典型用途", values: ["函数调用、撤销、括号匹配", "任务排队、广度优先搜索"] },
  ],
  summary: "要「回到上一步」用栈，要「按到达顺序处理」用队列。",
});

const QUIZ = widget({
  type: "micro_quiz", topic: "栈", difficulty: "基础",
  question: "依次入栈 1、2、3，然后出栈一次，再入栈 4。此时从栈顶到栈底依次是？",
  options: ["4, 2, 1", "4, 3, 2", "1, 2, 4", "3, 2, 1"], answerIndex: 0,
  hint: "先想清楚出栈一次拿走的是哪个数。",
  explanation: "出栈拿走的是最后进去的 3，剩下 1、2；再压入 4，栈顶到栈底是 4, 2, 1。选「4, 3, 2」是把出栈当成了拿走最早进去的 1。",
});

const CODE = widget({
  type: "code_playground", title: "补全：用列表实现出栈", language: "python", mode: "scaffold",
  instructions: "读入若干整数依次入栈，再全部出栈并输出。补全 TODO 处的代码。",
  starter_code: "stack = []\nfor x in input().split():\n    stack.append(int(x))\n\nout = []\nwhile stack:\n    # TODO: 请在此处补全：弹出栈顶并追加到 out\n    pass\nprint(*out)",
  test_cases: [{ name: "三个数", input: "1 2 3", expected: "3 2 1" }],
});

const TREE = fence("knowgap-visual", `<div class="kg-stack">
<h3>二叉树的三种遍历</h3>
<div class="kg-stage"><svg viewBox="0 0 300 160" width="100%">
<path class="kg-edge" d="M150 30L78 80M150 30L222 80M78 80L40 130M78 80L116 130M222 80L184 130M222 80L260 130"/>
<g id="nodes"></g>
</svg></div>
<div class="kg-row"><button data-o="pre">前序</button><button data-o="in">中序</button><button data-o="post">后序</button><button id="ask" class="is-primary">追问这棵树</button></div>
<p class="kg-caption">点一种遍历，节点按访问顺序依次点亮，旁边的数字是第几个被访问。</p>
</div>
<script>
(function () {
  var pos = [[150,30],[78,80],[222,80],[40,130],[116,130],[184,130],[260,130]];
  var order = {pre:[1,2,4,5,3,6,7], in:[4,2,5,1,6,3,7], post:[4,5,2,6,7,3,1]}, timer = null;
  var g = document.getElementById("nodes");
  g.innerHTML = pos.map(function (p, i) {
    return '<circle class="kg-node" cx="' + p[0] + '" cy="' + p[1] + '" r="14"/>'
      + '<text class="kg-label" x="' + p[0] + '" y="' + p[1] + '">' + (i + 1) + '</text>'
      + '<text class="kg-label" data-n x="' + (p[0] + 20) + '" y="' + (p[1] - 12) + '" fill="var(--accent)"></text>';
  }).join("");
  var nodes = g.querySelectorAll("circle"), marks = g.querySelectorAll("[data-n]");
  var tabs = document.querySelectorAll("button[data-o]");
  function play(tab) {
    var seq = order[tab.getAttribute("data-o")], step = 0, i;
    clearInterval(timer);
    for (i = 0; i < tabs.length; i++) tabs[i].classList.toggle("is-active", tabs[i] === tab);
    for (i = 0; i < nodes.length; i++) { nodes[i].classList.remove("is-active"); marks[i].textContent = ""; }
    timer = setInterval(function () {
      if (step >= seq.length) { clearInterval(timer); return; }
      nodes[seq[step] - 1].classList.add("is-active");
      marks[seq[step] - 1].textContent = String(step + 1);
      step += 1;
    }, 420);
  }
  for (var j = 0; j < tabs.length; j++) tabs[j].addEventListener("click", function () { play(this); });
  document.getElementById("ask").addEventListener("click", function () { knowgap.ask("按这棵树走一遍后序，为什么根节点最后才被访问？"); });
})();
</script>`);

const SLIDER = fence("knowgap-visual", `<div class="kg-stack">
<h3>命中率怎样影响平均访存时间</h3>
<div class="kg-field"><label>命中率 <b id="hp">80%</b></label><input id="h" type="range" min="0" max="100" value="80"></div>
<div class="kg-field"><label>缺失代价 <b id="mp">50 周期</b></label><input id="m" type="range" min="1" max="200" value="50"></div>
<div class="kg-grid">
<div class="kg-stat"><span>平均访存</span><b id="out">10.8 周期</b></div>
<div class="kg-stat"><span>缺失耗时占比</span><b id="share" style="color:var(--orange)">92.6%</b></div>
</div>
<div class="kg-bar"><div id="a" style="width:7.4%"></div><div id="g" class="is-orange" style="width:92.6%"></div></div>
<div class="kg-legend"><span><i class="kg-dot"></i>命中耗时</span><span><i class="kg-dot is-orange"></i>缺失耗时</span></div>
<p class="kg-caption">命中记 1 周期。把命中率往下拖一点，看缺失耗时多快占满整条。</p>
</div>
<script>
(function () {
  var h = document.getElementById("h"), m = document.getElementById("m");
  function text(id, value) { document.getElementById(id).textContent = value; }
  function render() {
    var hit = +h.value / 100, miss = (1 - +h.value / 100) * +m.value, total = hit + miss || 1;
    text("hp", h.value + "%");
    text("mp", m.value + " 周期");
    text("out", (hit + miss).toFixed(1) + " 周期");
    text("share", (miss / total * 100).toFixed(1) + "%");
    document.getElementById("a").style.width = (hit / total * 100).toFixed(1) + "%";
    document.getElementById("g").style.width = (miss / total * 100).toFixed(1) + "%";
  }
  h.addEventListener("input", render);
  m.addEventListener("input", render);
  render();
})();
</script>`);

const TIMELINE = fence("knowgap-visual", `<div class="kg-stack">
<h3>HTTP 协议的演进</h3>
<div class="kg-timeline">
<div class="kg-event"><b>1991 · HTTP/0.9</b><span>只有 GET，一次请求取回一个 HTML 页面。</span></div>
<div class="kg-event"><b>1996 · HTTP/1.0</b><span>加入请求头、响应头和状态码，能传图片等任意内容。</span></div>
<div class="kg-event"><b>1997 · HTTP/1.1</b><span>连接可以复用，同一条连接上依次发多个请求。</span></div>
<div class="kg-event"><b>2015 · HTTP/2</b><span>多路复用：同一条连接上，多个请求同时在途。</span></div>
<div class="kg-event"><b>2022 · HTTP/3</b><span>换成基于 UDP 的 QUIC，丢一个包不再拖住所有请求。</span></div>
</div>
<div class="kg-row"><button id="prev">上一版</button><button id="next" class="is-primary">下一版</button></div>
<p class="kg-caption">点按钮往后走：走过的版本变绿，当前的版本变蓝。</p>
</div>
<script>
(function () {
  var events = document.querySelectorAll(".kg-event"), cur = 0;
  function show() {
    for (var i = 0; i < events.length; i++) events[i].className = "kg-event" + (i < cur ? " is-done" : i === cur ? " is-active" : "");
    document.getElementById("prev").disabled = cur === 0;
    document.getElementById("next").disabled = cur === events.length - 1;
  }
  document.getElementById("prev").addEventListener("click", function () { cur -= 1; show(); });
  document.getElementById("next").addEventListener("click", function () { cur += 1; show(); });
  show();
})();
</script>`);

const FLOW = fence("knowgap-visual", `<div class="kg-stack">
<h3>C 程序从源码到可执行文件</h3>
<div class="kg-flow">
<div class="kg-box">源代码<small>main.c</small></div>
<div class="kg-box">预处理<small>展开头文件和宏</small></div>
<div class="kg-box">编译<small>生成汇编</small></div>
<div class="kg-box">汇编<small>生成目标文件</small></div>
<div class="kg-box">链接<small>合并库函数</small></div>
<div class="kg-box">可执行文件<small>a.out</small></div>
</div>
<div class="kg-row"><button id="go" class="is-primary">走一遍</button><button id="ask">追问：链接报错怎么看</button></div>
<p class="kg-caption">点“走一遍”，各阶段依次亮起。窗口窄时方框会换行，箭头只画在同一行的相邻方框之间。</p>
</div>
<script>
(function () {
  var boxes = document.querySelectorAll(".kg-box"), timer = null;
  function paint(step) {
    for (var i = 0; i < boxes.length; i++) boxes[i].className = "kg-box" + (i < step ? " is-done" : i === step ? " is-active" : "");
  }
  document.getElementById("go").addEventListener("click", function () {
    var step = 0;
    clearInterval(timer);
    timer = setInterval(function () {
      paint(step);
      if (step === boxes.length) clearInterval(timer);
      step += 1;
    }, 500);
  });
  document.getElementById("ask").addEventListener("click", function () { knowgap.ask("链接阶段报 undefined reference 是怎么回事？"); });
})();
</script>`);

const CELLS = fence("knowgap-visual", `<div class="kg-stack">
<h3>冒泡排序：每一趟把最大的送到最右边</h3>
<div class="kg-stage"><div id="row" class="kg-cells"></div></div>
<div class="kg-row"><button id="next" class="is-primary">下一步</button><button id="again">重来</button><span id="tip" class="kg-chip"></span></div>
<p class="kg-caption">蓝色是正在比较的两格；橙色表示前面更大、要交换；绿色是已经排好的位置。格子下面的数字是下标。</p>
</div>
<script>
(function () {
  var data = [5, 2, 8, 1, 9, 3], n = data.length, a = data.slice(), frames = [], k = 0, i, j, t;
  for (i = n - 1; i > 0; i--) {
    for (j = 0; j < i; j++) {
      frames.push({ a: a.slice(), j: j, swap: a[j] > a[j + 1], done: i + 1 });
      if (a[j] > a[j + 1]) { t = a[j]; a[j] = a[j + 1]; a[j + 1] = t; }
    }
  }
  frames.push({ a: a.slice(), j: -1, swap: false, done: 0 });
  var row = document.getElementById("row"), tip = document.getElementById("tip"), next = document.getElementById("next"), html = "";
  for (i = 0; i < n; i++) html += '<div class="kg-cell" data-i="' + i + '"></div>';
  row.innerHTML = html;
  function show() {
    var f = frames[k], c, cls;
    for (c = 0; c < n; c++) {
      cls = c >= f.done ? " is-done" : (c === f.j || c === f.j + 1) ? (f.swap ? " is-warn" : " is-active") : "";
      row.children[c].textContent = f.a[c];
      row.children[c].className = "kg-cell" + cls;
    }
    tip.textContent = f.j < 0 ? "排好了" : "比较 " + f.a[f.j] + " 和 " + f.a[f.j + 1] + (f.swap ? "：前面更大，交换" : "：顺序对，不动");
    next.disabled = k === frames.length - 1;
  }
  next.addEventListener("click", function () { k += 1; show(); });
  document.getElementById("again").addEventListener("click", function () { k = 0; show(); });
  show();
})();
</script>`);

const CHART = fence("knowgap-visual", `<div class="kg-stack">
<h3>复习得越多，遗忘得越慢</h3>
<div class="kg-field"><label>记忆强度 <b id="sv">3 天</b></label><input id="s" type="range" min="1" max="10" value="3"></div>
<div class="kg-stage"><svg viewBox="0 0 320 176" width="100%">
<path class="kg-gridline" d="M40 20H290M40 52.5H290M40 85H290M40 117.5H290M165 20V150"/>
<path class="kg-axis" d="M40 14V150H290"/>
<text class="kg-label is-muted is-end" x="34" y="20">100%</text>
<text class="kg-label is-muted is-end" x="34" y="85">50%</text>
<text class="kg-label is-muted is-end" x="34" y="150">0</text>
<text class="kg-label is-muted" x="40" y="165">刚学完</text>
<text class="kg-label is-muted" x="165" y="165">第 7 天</text>
<text class="kg-label is-muted" x="290" y="165">第 14 天</text>
<g id="g"></g>
</svg></div>
<div class="kg-grid">
<div class="kg-stat"><span>第 7 天还记得</span><b id="keep">10%</b></div>
<div class="kg-stat"><span>记忆减半要</span><b id="half">2.1 天</b></div>
</div>
<p class="kg-caption">按 R = e^(-t/S) 画的简化曲线。灰线是没复习过（S = 1），蓝线是现在的强度，圆点标出第 7 天的保留率。</p>
</div>
<script>
(function () {
  var s = document.getElementById("s"), g = document.getElementById("g");
  function X(t) { return 40 + t * 250 / 14; }
  function Y(r) { return 150 - 130 * r; }
  function curve(k) {
    var pts = [], t;
    for (t = 0; t <= 14; t += 0.5) pts.push(X(t).toFixed(1) + "," + Y(Math.exp(-t / k)).toFixed(1));
    return pts.join(" ");
  }
  function render() {
    var k = +s.value, r = Math.exp(-7 / k), y = Y(r), pct = Math.round(r * 100) + "%";
    document.getElementById("sv").textContent = k + " 天";
    document.getElementById("keep").textContent = pct;
    document.getElementById("half").textContent = (k * Math.LN2).toFixed(1) + " 天";
    g.innerHTML = '<polyline class="kg-plot is-muted" points="' + curve(1) + '"/>'
      + '<polyline class="kg-plot" points="' + curve(k) + '"/>'
      + '<circle class="kg-point" r="4" cx="' + X(7) + '" cy="' + y.toFixed(1) + '"/>'
      + '<text class="kg-label is-accent is-start" x="' + (X(7) + 9) + '" y="' + (y - 11).toFixed(1) + '">' + pct + '</text>';
  }
  s.addEventListener("input", render);
  render();
})();
</script>`);

const SAMPLES: Record<string, { label: string; text: string }> = {
  step: { label: "分步推演", text: `先看一遍入栈和出栈时 top 是怎么动的：\n\n${STEP}\n\n走完四步后，可以想想连续出栈两次会发生什么。` },
  compare: { label: "概念对比", text: `这两个结构最容易混，放在一张表里看：\n\n${COMPARE}` },
  quiz: { label: "随堂小测", text: `用一道小题检查一下：\n\n${QUIZ}` },
  code: { label: "代码实验台", text: `动手补一行代码试试：\n\n${CODE}` },
  tree: { label: "可视化：遍历", text: `点下面的按钮，看三种遍历的访问顺序：\n\n${TREE}` },
  slider: { label: "可视化：滑块", text: `拖动滑块，观察平均访存时间的变化：\n\n${SLIDER}` },
  timeline: { label: "可视化：时间线", text: `按版本往后走，看协议是怎么一步步变的：\n\n${TIMELINE}` },
  flow: { label: "可视化：流程", text: `一个 C 程序要经过这几步才能运行：\n\n${FLOW}` },
  cells: { label: "可视化：数组格", text: `一步一步看冒泡排序怎么比较和交换：\n\n${CELLS}` },
  chart: { label: "可视化：折线图", text: `拖动滑块，看复习怎样让遗忘曲线变缓：\n\n${CHART}` },
};

/** 容器宽度预设：支线窄面板、常规对话列、全屏面板等；null 表示不限制 */
const WIDTHS: Array<number | null> = [null, 360, 420, 560, 740, 960];
const TEXT_SIZES = [
  { id: "small", label: "小" },
  { id: "medium", label: "标准" },
  { id: "large", label: "大" },
] as const;

/** Development-only gallery of every learning card, static and replayed as a stream. */
export default function WidgetGallery() {
  if (process.env.NODE_ENV !== "development") return <p>此预览仅在开发环境可用。</p>;
  return <WidgetGalleryBody />;
}

function WidgetGalleryBody() {
  const [key, setKey] = useState("step");
  const full = SAMPLES[key].text;
  const [shown, setShown] = useState(full);
  const [speed, setSpeed] = useState(6);
  const timer = useRef(0);
  const { lang, setLang } = useI18n();
  const [width, setWidth] = useState<number | null>(null);
  const [textSize, setTextSize] = useState<"small" | "medium" | "large">("medium");

  // 阅读字号是根元素上的属性；离开这个页面时恢复成标准
  useEffect(() => {
    const root = document.documentElement;
    if (textSize === "medium") delete root.dataset.textSize;
    else root.dataset.textSize = textSize;
    return () => { delete root.dataset.textSize; };
  }, [textSize]);

  const stop = () => window.clearInterval(timer.current);
  useEffect(() => { stop(); setShown(full); return stop; }, [full]);

  const replay = () => {
    stop();
    let length = 0;
    setShown("");
    timer.current = window.setInterval(() => {
      length = Math.min(full.length, length + speed);
      // 和真实对话一样：卡片围栏一旦开始，就直接跳到当前已到达的内容，不逐字重排
      setShown(fastForwardWidgets(full.slice(0, length), full.slice(0, Math.min(full.length, length + speed * 4))));
      if (length >= full.length) { stop(); setShown(full); }
    }, 40);
  };

  const live = shown !== full;
  const buttons = useMemo(() => Object.entries(SAMPLES), []);
  return (
    <main style={{ maxWidth: 1040, margin: "0 auto", padding: "20px 16px 80px" }}>
      <header style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", paddingBottom: 16 }}>
        <strong style={{ marginRight: 8 }}>卡片预览</strong>
        {buttons.map(([id, sample]) => (
          <button key={id} onClick={() => setKey(id)} aria-pressed={id === key}
            style={{ padding: "4px 10px", borderRadius: 999, border: "1px solid var(--border-strong)", background: id === key ? "var(--bg-active)" : "transparent", fontSize: 13 }}>
            {sample.label}
          </button>
        ))}
        <button onClick={replay} style={{ marginLeft: "auto", padding: "4px 12px", borderRadius: 999, background: "var(--ink-solid)", color: "var(--on-ink)", fontSize: 13 }}>
          重播流式生成
        </button>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--text-secondary)" }}>
          速度
          <input type="range" min={2} max={24} value={speed} onChange={(event) => setSpeed(Number(event.target.value))} />
        </label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", width: "100%", fontSize: 12, color: "var(--text-secondary)" }}>
          <span role="group" aria-label="容器宽度" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            宽度
            {WIDTHS.map((value) => (
              <button key={value ?? "auto"} onClick={() => setWidth(value)} aria-pressed={value === width}
                style={{ padding: "2px 8px", borderRadius: 999, border: "1px solid var(--border-strong)", background: value === width ? "var(--bg-active)" : "transparent", fontSize: 12 }}>
                {value ?? "自适应"}
              </button>
            ))}
          </span>
          <span role="group" aria-label="界面语言" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            语言
            {(["zh", "en"] as const).map((value) => (
              <button key={value} onClick={() => setLang(value)} aria-pressed={value === lang}
                style={{ padding: "2px 8px", borderRadius: 999, border: "1px solid var(--border-strong)", background: value === lang ? "var(--bg-active)" : "transparent", fontSize: 12 }}>
                {value === "zh" ? "中文" : "English"}
              </button>
            ))}
          </span>
          <span role="group" aria-label="阅读字号" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            字号
            {TEXT_SIZES.map((size) => (
              <button key={size.id} onClick={() => setTextSize(size.id)} aria-pressed={size.id === textSize}
                style={{ padding: "2px 8px", borderRadius: 999, border: "1px solid var(--border-strong)", background: size.id === textSize ? "var(--bg-active)" : "transparent", fontSize: 12 }}>
                {size.label}
              </button>
            ))}
          </span>
        </div>
      </header>
      <div style={{ width: width ?? "100%", maxWidth: "100%", "--chat-text-w": width ? `${width}px` : "960px" } as CSSProperties}>
        <Markdown text={shown} live={live} />
      </div>
    </main>
  );
}
