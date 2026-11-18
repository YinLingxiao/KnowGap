# 书卷风界面风格调整 · 编码任务清单

> 需求基线：`.codeartsdoer/specs/bookish_theme/spec.md`  
> 设计基线：`.codeartsdoer/specs/bookish_theme/design.md`  
> 本文仅规划后续实施任务。任务规划阶段不修改业务代码、不执行本文所列搜索或工程验收命令、不生成任何验收结果。

## 实施总边界

- 后续实施的业务代码变更严格限定为 5 个文件：`frontend/src/app/globals.css`、`frontend/src/components/agenda/TaskComposer.module.css`、`frontend/src/components/chat/LearningWidget.module.css`、`frontend/src/components/home/TodayPanel.module.css`、`frontend/src/components/MaterialPreviewPanel.tsx`。
- 默认按任务 1 → 2 → 3 → 4 → 5 → 6 执行；任务 2 的两处深色必须使用同一份映射，任务 5 完成后才能开始任务 6。任一工程命令失败并修复后，必须从任务 6.1 开始重跑完整序列。
- 禁止修改布局、间距、尺寸、字号阶梯、侧栏、组件结构、React Props、边框、分割线、阴影、背景、绿色、琥珀色、深色三级文字色、文案、中英文消息文件、后端、API、依赖版本和消息协议。
- 禁止新增全局 CSS 变量、字体包、字体文件、图片、外部字体请求、纸纹或其他装饰；禁止改变既有字体栈、`--leading-read: 1.65` 和 `data-read-font="sans"` 回退行为。
- `frontend/src/components/chat/SubjectPage.module.css` 整个文件不修改；`frontend/src/components/MaterialLibrary.tsx` 不修改。七个宋体标题白名单、TaskInspector 与 CheatSheet 的局部字体覆盖均只核对、不修改。
- 截图、computed font-family 字体检查、阅读回退实测和 Contrast 对比度实测均为**用户方验收**，不属于实现方执行任务。实现方不得代做、代填或自行宣告这些项目通过，工程命令通过也不能替代用户方界面验收。

## 1. 核对实施基线并冻结最小修改范围

**依赖**：无；必须先于任何业务代码编辑完成。

- [ ] **1.1 定位五个修改文件的实施锚点并记录既有差异**
  - **文件范围**：读取 `frontend/src/app/globals.css`、`frontend/src/components/agenda/TaskComposer.module.css`、`frontend/src/components/chat/LearningWidget.module.css`、`frontend/src/components/home/TodayPanel.module.css`、`frontend/src/components/MaterialPreviewPanel.tsx`；记录实施前工作区状态，不修改文件。
  - **执行内容**：定位浅色 `:root`、系统深色 `:root:not([data-theme="light"])`、手动深色 `:root[data-theme="dark"]`，三个目标标题选择器，以及 `DOCX_IFRAME_HTML` 的 `body` 字体声明；对照 design.md 2.2.2、2.3.2 记录改前值和已有工作区改动，避免覆盖用户已有修改。
  - **验证方式**：逐项核对选择器、变量名和改前值与设计基线一致；若实际代码与基线不符，暂停实施并请求确认，不自行扩大修改范围。
  - **完成标准**：五个文件的全部修改锚点均已定位，既有差异已记录，可以按最小差异方式开始任务 2。

- [ ] **1.2 核对只读文件和既有字体例外的实施前状态**
  - **文件范围**：只读核对 `frontend/src/components/chat/SubjectPage.module.css`、`frontend/src/components/MaterialLibrary.tsx`、design.md 2.2.2 所列七个宋体白名单文件、`TaskInspector.module.css`、`CheatSheet.module.css`、侧栏和设置弹窗相关文件；不得修改。
  - **执行内容**：确认 `.heading h1` 仍为 13px 且未引用 `--font-display`，`MaterialLibrary.tsx` 的 SVG `fontFamily="sans-serif"` 与 `SubjectPage.module.css` 的 `var(--font-mono, ui-monospace, monospace)` 原样存在；确认七个白名单仍使用 `--font-display` 和 600 字重，局部黑体覆盖与侧栏、设置弹窗继承机制不缺失。
  - **验证方式**：以 design.md 2.2.2、2.4.1 为清单逐项比对，只记录现状，不为“统一风格”补充任何字体规则。
  - **完成标准**：所有只读锚点与例外均已确认；不存在需要借本需求修正的偏差，或已暂停并请求用户确认偏差处理方式。

## 2. 定点更新三处主题颜色变量并核对深色一致性

**依赖**：任务 1 完成。仅允许修改 `frontend/src/app/globals.css` 中下列变量的值。

- [ ] **2.1 更新浅色 `:root` 的 10 个目标变量**
  - **文件范围**：`frontend/src/app/globals.css` 的浅色 `:root`，不得修改其他选择器或变量。
  - **执行内容**：仅按下表定点替换，不对整个文件做旧色值批量替换；尤其只改 `--text` 的单个声明，不得误改同为旧值的 `--ink-solid`。

    | 变量 | 改前 | 改后 |
    | --- | --- | --- |
    | `--accent` | `#2f5fd0` | `#2b4c7e` |
    | `--accent-hover` | `#2550b8` | `#23406b` |
    | `--accent-text` | `#2550b8` | `#2b4c7e` |
    | `--accent-soft` | `rgb(47 95 208 / 9%)` | `rgb(43 76 126 / 9%)` |
    | `--accent-soft-strong` | `rgb(47 95 208 / 16%)` | `rgb(43 76 126 / 16%)` |
    | `--accent-solid` | `#2f5fd0` | `#2b4c7e` |
    | `--accent-solid-hover` | `#2550b8` | `#23406b` |
    | `--red` | `#c0392f` | `#b5412f` |
    | `--red-soft` | `rgb(192 57 47 / 9%)` | `rgb(181 65 47 / 9%)` |
    | `--text` | `#1c1b18` | `#23211c` |

  - **验证方式**：查看该文件差异，逐项对照 design.md 2.3.2 A 表；检查变量名、RGB 通道和 alpha，确认只出现上述 10 处值变更。
  - **完成标准**：10 个变量均等于目标字面值；`--accent-soft`、`--accent-soft-strong`、`--red-soft` 分别保持 9%、16%、9%，`--ink-solid: #1c1b18` 及其他声明不变。

- [ ] **2.2 将同一份九变量映射同步应用到两处深色定义**
  - **文件范围**：`frontend/src/app/globals.css` 中 `@media (prefers-color-scheme: dark)` 内的 `:root:not([data-theme="light"])`，以及独立的 `:root[data-theme="dark"]`；不得合并选择器或调整级联结构。
  - **执行内容**：按相同变量顺序分别更新两个深色块，每块均严格使用下表目标值；不得修改深色 `--text` 系变量。

    | 变量 | 两处改前 | 两处改后 |
    | --- | --- | --- |
    | `--accent` | `#6d93e8` | `#8aa6d6` |
    | `--accent-hover` | `#86a6ee` | `#9db8e4` |
    | `--accent-text` | `#8fb0f2` | `#9db8e4` |
    | `--accent-soft` | `rgb(109 147 232 / 13%)` | `rgb(138 166 214 / 13%)` |
    | `--accent-soft-strong` | `rgb(109 147 232 / 22%)` | `rgb(138 166 214 / 22%)` |
    | `--accent-solid` | `#4770d0` | `#46639c` |
    | `--accent-solid-hover` | `#3f67c6` | `#3a5386` |
    | `--red` | `#e0705f` | `#d4786a` |
    | `--red-soft` | `rgb(224 112 95 / 13%)` | `rgb(212 120 106 / 13%)` |

  - **验证方式**：分别查看两个深色块的差异，确认九项均已替换且只替换值；检查系统深色和手动深色的媒体查询、选择器及变量顺序未被重构。
  - **完成标准**：两个深色块各有一组完整的九项目标定义；alpha 均保持 13%、22%、13%，深色 `--text` / `--text-secondary` / `--text-tertiary` 仍分别为 `#ecebe6` / `#a3a097` / `#86837b`。

- [ ] **2.3 完成三处主题定义和未修改项的静态交叉核对**
  - **文件范围**：`frontend/src/app/globals.css` 最终差异及三处主题定义，不扩展到组件改色。
  - **执行内容**：为深色九项逐项记录“目标值、系统深色实际值、手动深色实际值”，按字面值三方比较；核对浅色 10 项各定义一次、深色九项在两个块中各定义一次。同步检查 `--on-accent: #ffffff`、浅色/深色 `--bg`、`--ink-solid`、字体栈与别名、`--leading-read`、`data-read-font="sans"` 回退规则不变。
  - **验证方式**：比较时只允许忽略缩进和换行，不做 hex/rgb 转换、近似色判断、alpha 归一化或四舍五入；审查差异确认边框变量、阴影变量、背景、绿色、琥珀色、深色三级文字色及其他未列明声明均零变化。
  - **完成标准**：浅色 10 项全部符合映射，两处深色九项字面值完全一致，变量次数与 alpha 正确，所有未修改项保持不变，未新增任何全局变量或装饰规则。

## 3. 仅将三个弹窗或卡片标题改回黑体

**依赖**：任务 2 完成。每个子任务只允许修改对应选择器的一条 `font-family` 变量引用，其他声明与 TSX 均不动。

- [ ] **3.1 将新建任务弹窗标题改为界面黑体**
  - **文件范围**：`frontend/src/components/agenda/TaskComposer.module.css` 的 `.header h2`。
  - **执行内容**：只把 `font-family: var(--font-display)` 改为 `font-family: var(--font-sans)`。
  - **验证方式**：检查该文件差异仅为此一处引用变化；确认 `margin`、字号、600 字重、颜色、其他声明和弹窗结构未变。
  - **完成标准**：`.header h2` 仅引用 `--font-sans`，不存在新增选择器、字体字面量或任何布局、间距、字重调整。

- [ ] **3.2 将对话内学习卡片标题改为界面黑体**
  - **文件范围**：`frontend/src/components/chat/LearningWidget.module.css` 的 `.widgetTitle`。
  - **执行内容**：只把 `font-family: var(--font-display)` 改为 `font-family: var(--font-sans)`。
  - **验证方式**：检查该文件差异仅为此一处引用变化；确认颜色、`--text-xl`、600 字重、行高、字距和文本换行等声明均未变化。
  - **完成标准**：`.widgetTitle` 仅引用 `--font-sans`，没有新增通用标题规则或其他样式改动。

- [ ] **3.3 将首页“今日”面板标题改为界面黑体**
  - **文件范围**：`frontend/src/components/home/TodayPanel.module.css` 的 `.header h2`。
  - **执行内容**：只把 `font-family: var(--font-display)` 改为 `font-family: var(--font-sans)`。
  - **验证方式**：检查该文件差异仅为此一处引用变化；确认 `--text-xl`、600 字重、字距、面板布局和其他声明均未变化。
  - **完成标准**：`.header h2` 仅引用 `--font-sans`，未改动任何结构、布局、间距或文案。

## 4. 调整 docx 隔离 iframe 的衬线字体栈并保留安全边界

**依赖**：任务 3 完成。仅允许修改 `frontend/src/components/MaterialPreviewPanel.tsx` 的 `DOCX_IFRAME_HTML` 内联 `body` 字体声明及相邻解释注释。

- [ ] **4.1 将 docx iframe 正文改为规格指定的固定衬线字体栈**
  - **文件范围**：`frontend/src/components/MaterialPreviewPanel.tsx` 中 `DOCX_IFRAME_HTML` 的 `body` `font-family`，不修改其他预览分支。
  - **执行内容**：仅将现有 `font-family: sans-serif` 替换为 `"Source Serif 4 Variable", "Source Serif 4", "Noto Serif SC Variable", "Songti SC", "STSong", Georgia, serif`；使用固定字面量，不拼接用户输入或文档内容，不引用父页面 CSS 变量。
  - **验证方式**：对照 design.md 2.2.2 C 项逐项检查字体名称、顺序、引号和最终 `serif` 兜底；查看差异确认未修改 PDF、XLSX、CSV、Markdown 等其他预览格式。
  - **完成标准**：docx `body` 字体栈与 `--font-read` 对应衬线栈顺序完全一致，这是本文件唯一新增字体族字面量例外，未新增外部字体资源或动态输入。

- [ ] **4.2 补充 opaque origin 例外注释并核对沙箱和消息协议零变化**
  - **文件范围**：`frontend/src/components/MaterialPreviewPanel.tsx` 中上述字体声明的相邻位置及只读安全属性；不调整 TSX 结构。
  - **执行内容**：添加简短注释，说明 docx iframe 为 opaque origin、无法继承父页面 CSS 变量，因此保留规格许可的固定字体栈，并提示该字体顺序需与 `--font-read` 对应栈人工保持一致。
  - **验证方式**：静态核对 `sandbox="allow-scripts"` 原样保留且未添加 `allow-same-origin`；确认 `srcDoc` 分发、脚本来源与执行顺序、`postMessage` 消息来源检查、`targetOrigin`、渲染配置、错误处理和界面文案均未改变。
  - **完成标准**：例外原因和人工同步要求均有相邻注释，安全权限没有扩大，文件差异仅限任务 4.1 的字体声明和本任务的解释注释。

## 5. 审查最小差异并全局搜索组件旧色值

**依赖**：任务 2、3、4 全部完成；必须先于任务 6。若本阶段发生任何业务代码修正，须重新执行本阶段相关核对与搜索。

- [ ] **5.1 核对五个业务文件差异及全部禁止修改项**
  - **文件范围**：审查全部业务代码差异，重点为任务 2—4 的五个文件；只读核对七个宋体白名单、`SubjectPage.module.css`、`MaterialLibrary.tsx`、TaskInspector、CheatSheet、侧栏、设置弹窗及其他组件。
  - **执行内容**：确认业务代码变更仅涉及五个获准文件，且内容仅为浅色 10 项、两处深色九项、三个标题字体引用、docx 字体栈与例外注释。逐项确认七个白名单的 `--font-display` 与 600 字重不变，`SubjectPage.module.css` 整个文件零差异，`MaterialLibrary.tsx` 的 SVG 例外零差异，等宽兜底、局部黑体覆盖、既有 700 黑体角标均原样保留。
  - **验证方式**：通过最终差异和只读锚点比对检查是否存在布局、间距、尺寸、字号、侧栏、边框、阴影、文案、依赖、API、TSX 结构、字体资源或其他越界变更；发现越界差异时仅回退越界部分，再重新核对。
  - **完成标准**：五个业务文件的差异均可在 design.md 中找到唯一对应项，所有只读文件与例外保持原样，没有范围外修改。

- [ ] **5.2 从仓库根目录递归搜索组件中的全部本次旧色值并记录证据**
  - **文件范围**：至少递归覆盖 `frontend/src/components` 下的 CSS、SCSS、TS、TSX、JS、JSX；不是只搜索本次修改文件或 Git 差异。
  - **执行内容**：在仓库根目录 `D:\黑客松\KnowGap` 实际执行以下不区分大小写的搜索，并保存命令、工作目录、原样输出和退出结果：

    ```bash
    rg -n -i --glob '*.{css,scss,ts,tsx,js,jsx}' '(#2f5fd0|#2550b8|#6d93e8|#c0392f|#86a6ee|#8fb0f2|#4770d0|#3f67c6|#e0705f|#1c1b18|rgb\(\s*47\s+95\s+208|rgb\(\s*192\s+57\s+47|rgb\(\s*109\s+147\s+232|rgb\(\s*224\s+112\s+95)' frontend/src/components
    ```

    搜索集合必须覆盖四个明确旧色值及其余旧值 `#86a6ee`、`#8fb0f2`、`#4770d0`、`#3f67c6`、`#e0705f`、`#1c1b18`，以及 RGB 通道 `47 95 208`、`192 57 47`、`109 147 232`、`224 112 95`；RGB 匹配允许任意空白且不限定 alpha。
  - **验证方式**：无匹配行才判定组件旧色值为 0 处。`rg` 无匹配通常返回退出码 1，应如实解释为“未找到”，不得伪造成退出码 0；搜索工具执行错误不得解释为无匹配。发现残留时在规格范围内清理并重跑搜索。该 0 匹配标准只针对组件目录，不得据此删除 `globals.css` 中必须保留的 `--ink-solid: #1c1b18`。
  - **完成标准**：交付记录包含实际搜索命令、完整原样输出和退出结果，目标旧色值在组件中最终均为 0 处匹配；若搜索后再次修改业务代码，已重新搜索并按要求重跑任务 6 的完整工程序列。

## 6. 依次执行工程验收并整理可追溯交付记录

**依赖**：任务 5 全部通过。三条命令均在 `D:\黑客松\KnowGap\frontend`（即仓库的 `frontend/`）实际执行，顺序不可颠倒，不得跳过或用某条命令替代另一条。

- [ ] **6.1 执行 TypeScript 类型检查并保存真实结果**
  - **文件范围**：工作目录固定为 `frontend/`，使用现有 TypeScript 配置，不修改配置或依赖来规避错误。
  - **执行内容**：运行 `npx tsc --noEmit`，保存命令、工作目录、完整实际输出和退出结果。
  - **验证方式**：仅最终退出码 0 才算通过；成功无标准输出时如实记录“无输出”，不得编造输出或只写“通过”。失败时保留完整失败输出，进行规格内修复，并从本任务开始重跑完整三条命令；若修复需要越界，先暂停并请求确认。
  - **完成标准**：最终 `npx tsc --noEmit` 退出码为 0，实际输出可追溯，并已纳入交付记录。

- [ ] **6.2 在类型检查通过后执行 API 测试并保存真实结果**
  - **文件范围**：工作目录固定为 `frontend/`，使用 `frontend/package.json` 既有 `test:api` 脚本，不新增或改写测试脚本来规避失败。
  - **执行内容**：在任务 6.1 最终通过后运行 `npm run test:api`，保存命令、工作目录、完整实际输出和退出结果。
  - **验证方式**：仅最终退出码 0 才算通过，不得以类型检查或后续构建结果替代。失败时保留失败输出，进行规格内修复，并回到任务 6.1 重跑三条完整序列。
  - **完成标准**：最终 `npm run test:api` 退出码为 0，完整实际输出已纳入交付记录，所有失败与修复过程均可追溯。

- [ ] **6.3 在 API 测试通过后执行生产构建并保存真实结果**
  - **文件范围**：工作目录固定为 `frontend/`，使用既有生产构建脚本，不修改构建配置或依赖版本来绕过问题。
  - **执行内容**：在任务 6.2 最终通过后运行 `npm run build`，保存命令、工作目录、完整实际输出和退出结果。
  - **验证方式**：仅最终退出码 0 才算通过，不得只摘录成功摘要或以构建结果替代界面验收。失败时保留完整失败输出，进行规格内修复，并回到任务 6.1 重跑三条完整序列。
  - **完成标准**：最终 `npm run build` 退出码为 0，完整实际输出已纳入交付记录；任务 6.1—6.3 三条命令最终均通过且顺序正确。

- [ ] **6.4 汇总实现方证据并单列用户方待验收事项**
  - **文件范围**：实施交付说明，不新增业务文件，不代写用户验收结论。
  - **执行内容**：汇总五个业务文件的最小差异清单、浅色 10 项与两处深色九项核对表、alpha 和未修改项结论、三个标题及七个白名单核对结果、顶栏和两个既有字面量例外未变结论、docx 字体例外与 sandbox/消息协议未变说明、任务 5.2 搜索证据，以及任务 6.1—6.3 的完整真实输出和退出码；如有失败，附失败原因、修复说明和最终重跑结果。
  - **验证方式**：交付说明将“实现方工程证据”和“用户方验收”分栏。用户方栏目仅标记为待用户方执行和确认：浅色/深色各五个指定界面共 10 张截图；控件、白名单、13px 顶栏、docx、阅读区及 `data-read-font="sans"` 的 computed font-family/回退检查；浅色和深色正文、次要文字、强调色文字及实心按钮白字的 Contrast 实测。实现方不得勾选、代填或宣告这些项目通过。
  - **完成标准**：实现方证据完整且三条工程命令最终均为退出码 0；用户方截图、字体和对比度项目明确标注“由用户方验收”，不以估算值或工程结果冒充实测结论，等待用户方给出最终通过或退回意见。