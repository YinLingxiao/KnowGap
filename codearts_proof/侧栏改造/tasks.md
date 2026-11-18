# sidebar_layout 实施任务清单

## 规划基线与执行约束

本清单以 `.codeartsdoer/specs/sidebar_layout/spec.md` 和 `.codeartsdoer/specs/sidebar_layout/design.md` 的最新修订为基线。**本轮（2026-11-18）只执行第 9～12 项**，完成学习模式顶部入口、对话时间分组和工作台间距三处微调。本文件仅规划后续实施，不代表已经修改业务代码或运行验证命令。

### 本轮固定边界与依赖

- 业务代码只允许修改 `frontend/src/components/chat/ConversationSidebar.tsx` 与 `frontend/src/components/chat/ConversationSidebar.module.css`；不得修改 `ChatApp.tsx`、`i18n/messages.ts`、`globals.css`、`ChatApp.module.css`、依赖清单、锁文件或其它任何文件，不新增依赖。
- 本轮不新增、修改或删除中英文文案键，不调整组件属性、状态、分组规则、排序、搜索、数据请求或既有创建流程；底部「新建学习空间」胶囊按钮及其行为保持不变。
- 保留分组标题 sticky 定位、22px 高度、顶部吸附与不透明全宽背景，保留 `.scroll` 滚动机制、对话组序和组内排序；列表分区标题与工作台分区标题的文字样式不变。
- 本轮必跑检查仅为 `npx tsc --noEmit` 和 `npm run build`，并完成学习入口、分组对齐/间距及 760px 高窗口至少 8 条对话的浏览器复核；上一轮 `npm run test:api` 记录不作为本轮新增必跑项。
- **本轮依赖顺序：** 9 → 10 → 11 → 12。各子任务另列直接依赖；若返工，只可在两个限定文件内修复，并重跑受影响的自动检查与人工验收。

### 上一轮历史记录（第 1～8 项，已落地，禁止重复实施）

以下第 1～8 项完整保留为上一轮主体改造的历史记录，其复选框状态不再作为本轮执行依据。原四项调整、四文件改造边界和三命令验收均为当时的规划基线，仅供追溯；与本轮三处微调、两文件边界或两项必跑命令冲突时，一律以上方本轮约束及第 9～12 项为准，不得据历史任务恢复顶部新建入口或重复实施旧改动。

### 上一轮四项确认的优先调整（历史记录）

1. 删除侧栏「添加任务」按钮；日程页和对话中的既有添加任务能力必须保留。
2. 列表标题文案与计数分别渲染为两个 `span`；计数使用 `--text-tertiary` 且字号比标题小一级。`sidebar.chatListTitle` 中文为「对话记录」，`sidebar.spaceListTitle` 中文为「学习空间」，中英文标题资源均不包含 `{count}`。此项覆盖 `design.md` 2.4.1 中标题带 `{count}` 的旧设计。
3. 当前排序字段决定列表使用的同一时间值：选择「创建时间」时，对话和空间均使用 `createdAt`；选择「最近活动」时，对话使用 `updatedAt`，空间使用 `lastStudiedAt ?? updatedAt`。同一对象的该时间值必须同时用于排序、对话分组和行尾相对时间，不得混用。此项覆盖旧设计中“创建时间排序不改变对话组归属”的表述，并保留原设计的空间最近活动语义；空间 `updatedAt` 只反映改名或设置变化，不得取代 `lastStudiedAt` 所表达的学习活动。
4. 工作台和学习入口行高均为 28px；工作台、学习入口所属区域及列表分区标题使用 `--text-xs`、`--text-tertiary`，上下间距保持紧凑。以 760px 高窗口验收时，对话列表至少能看到 8 条。此项覆盖旧设计中相关区域约 32px 行高的表述。

### 上一轮固定边界（历史记录）

- 业务代码只允许修改：`frontend/src/components/chat/ConversationSidebar.tsx`、`frontend/src/components/chat/ConversationSidebar.module.css`、`frontend/src/components/chat/ChatApp.tsx`、`frontend/src/lib/i18n/messages.ts`。
- 不修改 `frontend/src/app/globals.css`、`ChatApp.module.css`、全局配色、全局设计变量、依赖清单或锁文件，不新增依赖、接口、网络请求、持久化键、业务服务、数据迁移或测试依赖。
- `ChatApp.tsx` 只清理侧栏不再使用的 `onOpenThread` 属性传递及失效局部注释；不得改动日程页和空间页的支线入口、既有创建流程、模式持久化、视图联动或抽屉行为。
- 保留普通对话筛选、五个时间分组及固定组序、重命名/删除契约、生成中圆点、加载与错误反馈、待处理支线空间页入口、侧栏收起、窄窗口抽屉、头像菜单、更新提示、模型异常、主题、帮助、设置和资料激活态。
- 排序在源数组副本上进行；搜索、排序、相对时间和红点只基于现有内存数据派生。相对时间在侧栏文件内实现，不修改共享的 `labels.ts`。
- 不新增 UI 测试文件；自动检查、固定样例自查和浏览器人工回归共同构成验收。

**上一轮历史依赖顺序（已执行，勿重复）：** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8。各子任务另列直接依赖；后续实施若因缺陷返工，必须重新执行受影响的验证。

## 1. 建立双语资源与统一时间基础

### 1.1 补齐双模式侧栏中英文文案
- [ ] 在 `frontend/src/lib/i18n/messages.ts` 中成对新增或调整 `sidebar.workspace`、`workspaceMaterials`、`workspaceMemories`、`allSpaces`、`chatListTitle`、`spaceListTitle`、`sortMenuAria`、`searchChatPlaceholder`、`searchSpacePlaceholder` 及 `timeJustNow/timeHour/timeHours/timeYesterday/timeDay/timeDays/timeWeek/timeWeeks` 中英文资源；两个列表标题只包含名称、不包含 `{count}`，计数插值仅用于时间数量文案。复用既有模式、分组、排序、搜索、空态和新建按钮键，将 `sidebar.threadAttention` 校准为“有待处理支线 / Threads need attention”。本任务无前置依赖；完成标准是中英文键集合一致、英文时间单复数表达自然，旧废弃键留待任务 7.1 在引用清理后删除。

### 1.2 建立当前排序时间取值与安全降序比较逻辑
- [ ] 在 `frontend/src/components/chat/ConversationSidebar.tsx` 中建立可复用的当前时间取值逻辑：对话和空间在 `sort === "created"` 时均返回 `createdAt`；在 `sort === "updated"` 时，对话返回 `updatedAt`，空间返回 `lastStudiedAt ?? updatedAt`，且仅在 `lastStudiedAt` 为 `null`/`undefined` 时回退到空间 `updatedAt`。同时建立可空时间安全比较逻辑，有效值按真实时间戳降序、无效值置后、相等返回 0。依赖：无，可与 1.1 并行；完成标准是不再使用字符串 `localeCompare` 代替时间比较、不修改源数组，且空间最近活动不得简化为只读取 `updatedAt`。

### 1.3 实现对话与空间共用的相对时间格式化
- [ ] 在 `frontend/src/components/chat/ConversationSidebar.tsx` 中基于现有 `translate` 和任务 1.1 的文案实现统一格式化，覆盖无效值为空、不足 1 小时及未来时间为“刚刚 / Just now”、当天完整小时、昨天、早于昨天且不足 7 个完整日的日历天数、满 7 日后的完整周数；小时、日、周向下取整，英文数量为 1 时使用单数键。依赖：1.1；完成标准是相同时间、语言和当前时刻在对话行与空间行得到相同文本，不出现负数、`NaN` 或技术错误文本，且不修改 `labels.ts` 或通用时间资源。

### 1.4 建立全列表共享的当前时间快照
- [ ] 在 `frontend/src/components/chat/ConversationSidebar.tsx` 中用一个组件级时间快照向分组和两类行尾时间提供同一 `now`，通过单个按分钟刷新的定时器保持时间更新，并在卸载时清理。依赖：1.3；完成标准是不为每行单独取时或建立定时器，不产生网络请求和全量数据重载，分组与行尾时间不会因逐行取时出现档位不一致。

## 2. 重构双模式固定导航与工作台

### 2.1 完善模式切换器的图标、选中态和焦点行为
- [ ] 在 `ConversationSidebar.tsx` 与 `ConversationSidebar.module.css` 中为“对话 / 学习”分别加入现有 `lucide-react` 的消息、书本图标并保留文字；选中态只使用浅底和主文字色，移除描边式阴影，鼠标点击不显示蓝色焦点框，Tab 聚焦保留 `:focus-visible` 焦点环。保留左右方向键、`aria-selected` 和焦点移动，重复选择当前模式不得调用父回调或重新加载，不得用强制 `blur()` 隐藏焦点。依赖：无；完成标准是鼠标与键盘路径均可用且不需要新增依赖。

### 2.2 增加学习模式上方的两行入口
- [ ] 在 `ConversationSidebar.tsx` 与 `ConversationSidebar.module.css` 中仅于学习模式、工作台上方依次渲染“新建学习空间”和“全部学习空间”两行图标加文字入口，行高均为 28px；新建行复用 `onCreateSpace`，全部空间行复用 `onOpenSpaces` 和 `spacesActive`，每次点击只发起一个既有流程。依赖：1.1；完成标准是对话模式不出现这两行，新建入口不直接创建重复空间，全部空间入口打开既有 `spaces` 视图并沿用窄窗口关闭行为。

### 2.3 将日程、资料、记忆重建为公共工作台分区
- [ ] 在 `ConversationSidebar.tsx` 与 `ConversationSidebar.module.css` 中用同一“工作台”分区替换三入口的裸图标表达，两种模式均按日程、资料、记忆顺序显示图标加文字行，每行高 28px，复用原导航回调及日程、资料激活态。依赖：1.1、2.2；完成标准是不再保留这三个入口的旧快捷按钮副本，点击当前或非当前入口均不改变既有视图语义。

### 2.4 删除侧栏添加任务入口但保留全局任务能力
- [ ] 在 `ConversationSidebar.tsx` 中删除「添加任务」按钮、其 `window.dispatchEvent` 处理以及因此失效的 `COMPOSE_TASK_EVENT`、`ListPlus` 导入；不得删除事件定义、`TaskComposer`、日程或对话中的既有派发和监听路径。依赖：2.3；完成标准是侧栏不再出现该按钮，日程页和对话里的既有添加任务路径仍可分别完成一次冒烟操作。

### 2.5 收紧固定导航分区样式并做阶段验证
- [ ] 在 `ConversationSidebar.module.css` 中把工作台和相关分区标题设为 `var(--text-xs)`、`var(--text-tertiary)`，压缩标题及学习入口区域的上下间距，同时保持列表可滚动和固定区域不互相遮挡；在 `ConversationSidebar.tsx` 仅做必要的类名对应。依赖：2.1～2.4；完成标准是中英文下两种模式的学习入口顺序、工作台三行、28px 行高、激活态和键盘焦点均正确，顶部不再保留旧三入口或添加任务按钮。

## 3. 实现列表标题、独立计数、排序菜单和标题下搜索

### 3.1 统一模式专属筛选结果与计数来源
- [ ] 在 `ConversationSidebar.tsx` 中先形成当前模式的筛选数组：对话继续排除非普通对话、所属空间记录和指定引导标题，只按对话标题匹配；空间只按名称匹配，支线标题不再使空间命中。依赖：2.5；完成标准是标题计数、空态判断和实际列表均读取同一过滤结果，关键词去首尾空白并不区分大小写，模式切换后按新模式重新过滤而不发请求。

### 3.2 始终渲染列表分区标题和分离计数
- [ ] 在 `ConversationSidebar.tsx` 与 `ConversationSidebar.module.css` 中把列表标题行移到加载、错误、空态和搜索无结果分支之外，左侧用一个 `span` 渲染 `sidebar.chatListTitle` 或 `sidebar.spaceListTitle`，另一个独立 `span` 渲染过滤后数组长度；标题使用 `--text-xs`、`--text-tertiary`，计数也使用 `--text-tertiary` 且字号比标题小一级。依赖：1.1、3.1；完成标准是初始空列表、搜索无结果及加载失败时标题和工具仍存在、计数为 0，标题翻译不含 `{count}`，数字不会重复拼入标题文案。

### 3.3 用两项排序菜单替换独立排序行
- [ ] 在 `ConversationSidebar.tsx` 与 `ConversationSidebar.module.css` 中把排序入口收拢为标题行右侧小图标按钮，菜单只含“最近活动”和“创建时间”，以 `menuitemradio`/`aria-checked` 或等价语义及非颜色标识标出当前项；选择后更新本地 `sort` 并关闭菜单。依赖：3.2；完成标准是默认值为 `updated`，两种模式共用该本地选择，不再显示独立“最近活动”排序行或点击直接轮换的旧按钮，不持久化排序。

### 3.4 将搜索接入标题行并移除旧快捷区残留
- [ ] 在 `ConversationSidebar.tsx` 与 `ConversationSidebar.module.css` 中把搜索图标放到标题行右侧、搜索框放到标题行正下方，使用当前模式的搜索占位文案；保留自动聚焦、清空、空输入失焦关闭和 Escape 同时清空并关闭的行为，非空查询不得因失焦被隐藏。依赖：2.4、3.3；完成标准是旧 `quickRow` 中最后一个搜索入口及顶部旧搜索位置被移除，标题行只有排序和搜索两个工具，清空或 Escape 后恢复完整列表和对应计数，模式切换保留查询和搜索展开状态。

### 3.5 完成排序浮层键盘、关闭和焦点管理
- [ ] 在 `ConversationSidebar.tsx` 与 `ConversationSidebar.module.css` 中复用现有浮层惯例实现视口内定位，支持方向键、Home、End、Escape、外部点击、滚动和窗口尺寸变化；未重新选择就关闭时不得改变排序，Escape 或选择后焦点返回排序按钮，模式变化时关闭瞬态菜单。依赖：3.3；完成标准是浮层不被滚动容器或窄窗口抽屉裁剪，所有监听器均在 effect 清理中释放，取消操作不改变列表顺序。

### 3.6 验证标题、工具、搜索和计数的所有列表状态
- [ ] 围绕 `ConversationSidebar.tsx`、`ConversationSidebar.module.css` 和 `messages.ts` 做阶段回归，覆盖有数据、初始空列表、搜索有结果/无结果、加载中、加载失败及模式切换。依赖：3.1～3.5；完成标准是 N 始终等于当前实际列出条数，错误与重试不被“没有匹配的内容”替代，搜索范围、菜单取消行为和计数在中英文下均正确。

## 4. 统一对话分组、组内排序和行尾相对时间

### 4.1 让对话组内顺序使用当前排序时间字段
- [ ] 在 `ConversationSidebar.tsx` 中对任务 3.1 的过滤结果副本使用任务 1.2 的当前字段取值和安全比较器排序，`created` 按 `createdAt` 降序、`updated` 按 `updatedAt` 降序，无效值置后，相等时保持原相对顺序。依赖：1.2、3.1、3.3；完成标准是排序不修改父组件数组，搜索与排序可组合且计数不因排序变化。

### 4.2 让五个对话分组也使用当前排序时间字段
- [ ] 在 `ConversationSidebar.tsx` 中调整 `chatGroupOf` 的输入与 `chatGroups` 派生，使每条对话以任务 4.1 相同的当前字段时间判断今天、昨天、本周、本月和更早，使用任务 1.4 的共享 `now`，固定组序不变，各组内部保持当前字段降序。依赖：1.4、4.1；完成标准是创建时间模式下组归属、组内顺序都基于 `createdAt`，最近活动模式下都基于 `updatedAt`，不再出现创建时间排序却仍按 `updatedAt` 分组的混用；无效时间沿用“更早”兜底。

### 4.3 让对话行尾时间与分组、组内顺序同源
- [ ] 在 `ConversationSidebar.tsx` 中向每条普通对话传入由当前字段时间和共享 `now` 生成的 `relativeTime`：创建时间模式格式化 `createdAt`，最近活动模式格式化 `updatedAt`，无效值传空文本。依赖：1.3、1.4、4.2；完成标准是同一次渲染的分组、组内顺序和行尾相对时间三者使用完全相同的时间字段，切换排序时三者同步更新。

### 4.4 实现稳定且可访问的对话行尾时间/操作切换
- [ ] 在 `ConversationSidebar.tsx` 与 `ConversationSidebar.module.css` 中让低强调灰色相对时间与“…”按钮共用固定网格或叠加区域；默认显示时间，悬停、行内聚焦或菜单打开时以“…”替换时间，无悬停设备始终提供可操作按钮，不以 `display: none` 改变行尾轨道尺寸。依赖：4.3；完成标准是时间和按钮不同时挤占行尾、切换前后标题与整行无横向跳动，长标题单行省略，生成中圆点独立保留，重命名和删除确认状态不叠加时间区域。

### 4.5 保留对话管理契约并验证时间字段一致性
- [ ] 围绕 `ConversationSidebar.tsx` 验证打开、重命名成功/失败、删除确认/失败、生成中圆点和无效时间，并构造 `createdAt` 与 `updatedAt` 落在不同日期组、具有不同先后关系的对话分别切换两种排序。依赖：4.1～4.4；完成标准是既有 `Promise<boolean>` 成功判定和失败恢复不变，两种排序下分组、组内顺序、行尾时间均按当前字段一起变化，长标题和无悬停操作仍可用。

## 5. 实现单层学习空间列表与聚合支线提醒

### 5.1 按空间聚合待处理支线布尔状态
- [ ] 在 `ConversationSidebar.tsx` 中一次遍历当前 `conversations` 建立按 `subjectId` 隔离的提醒映射，只处理 `thread`，排除 `threadStatus === "resolved"`，仅在 `executionStatus` 为 `waiting` 或 `failed` 时标记所属空间。依赖：3.1；完成标准是同一空间多条命中仍只有一个真值，其它执行态、缺省状态和无空间归属记录均不触发，不展示支线标题或数量。

### 5.2 用单层空间行替代可展开空间分区
- [ ] 在 `ConversationSidebar.tsx` 与 `ConversationSidebar.module.css` 中以 `SpaceListItem` 呈现色彩环、名称、至多一个红点和由当前字段生成的相对时间；点击整行只调用 `onOpenSubject(subject.id)`，当前空间仅用浅底强调并移除左侧竖条。依赖：1.3、1.4、5.1；完成标准是不显示展开按钮、子支线列表或空支线提示，长名称单行省略，红点和有效时间同时可见且互不覆盖，无效时间不显示错误文本。

### 5.3 让空间顺序和行尾时间使用当前排序时间字段
- [ ] 在 `ConversationSidebar.tsx` 中对任务 3.1 的空间过滤结果副本使用任务 1.2 的安全比较器，创建时间模式按 `createdAt` 降序，最近活动模式按 `lastStudiedAt ?? updatedAt` 降序，并以当前模式下的同一时间值生成任务 5.2 的行尾时间。依赖：1.2、3.3、5.2；完成标准是两种模式下空间顺序和行尾时间同步切换，无效值置后且相等排序稳定；最近活动模式在 `lastStudiedAt` 与 `updatedAt` 不同时优先采用前者，在前者为 `null`/`undefined` 时回退到后者，不得只按空间 `updatedAt` 排序或显示时间。

### 5.4 删除侧栏空间展开和支线直达实现
- [ ] 在 `ConversationSidebar.tsx` 中删除旧 `SpaceSection`、`expandedSpaces`、当前空间自动展开 effect、`toggleSpace`、`openThread`、`forceOpen`/`threads` 传递、`SidebarProps.onOpenThread`，以及 `ConversationItem` 只服务侧栏支线的 `variant`、`attention` 变体和失效图标导入。依赖：5.2、5.3；完成标准是普通对话的打开、生成圆点、重命名和删除逻辑仍保留，侧栏不存在展开状态或直接打开单条支线的路径。

### 5.5 成对移除 ChatApp 中仅属于侧栏的支线属性
- [ ] 在 `frontend/src/components/chat/ChatApp.tsx` 中仅删除传给 `ConversationSidebar` 的 `onOpenThread` 属性块及失效局部注释。依赖：5.4；完成标准是 `AgendaPage` 的 `onOpenThread`、空间面板存储键、`API_BASE_URL` 的其它使用、空间页支线入口、`TaskComposer`、所有导航/创建回调、模式持久化及抽屉行为保持原样，不错误删除仍被使用的导入。

### 5.6 验证空间提醒矩阵和既有支线可达性
- [ ] 围绕 `ConversationSidebar.tsx` 与 `ChatApp.tsx` 验证未解决等待/失败、已解决等待/失败、其它执行态、多条命中、空间隔离、点击带红点空间及日程支线入口。依赖：5.1～5.5；完成标准是仅未解决等待/失败触发且每行至多一个红点，点击空间进入对应空间页后仍能在既有支线面板访问触发提醒的支线，侧栏无支线直达而日程与空间页入口不回归。

## 6. 完成低强调底部创建按钮与紧凑窗口适配

### 6.1 实现自适应胶囊按钮视觉和状态
- [ ] 在 `ConversationSidebar.module.css` 中把底部主按钮设为高 36px、圆角 999px、可用宽度撑满且相对侧栏实际左右各 12px，图标和文字使用 `var(--text)`、字号 14px；默认/悬停/按下背景分别为主文字色 7%/11%/14% 的 `color-mix`，按下缩放 0.98，过渡复用现有时长和曲线。依赖：2.5；完成标准是无高饱和实心背景、无明显高对比边框、无写死灰色 RGBA、无 `filter: brightness()`，如保留边框则仅为主文字色 10% 同色系。

### 6.2 保留两种模式的创建内容与既有行为
- [ ] 在 `ConversationSidebar.tsx` 中让对话模式使用编辑线条图标和“新对话”、学习模式使用加号图标和“新建学习空间”，图标位于文字左侧并整体居中，分别复用 `onNewChat` 与 `onCreateSpace`。依赖：1.1、6.1；完成标准是每次点击只进入对应既有流程，取消或失败反馈不变，学习上方入口与底部入口不会直接产生重复空间。

### 6.3 以 760px 高窗口校准紧凑布局
- [ ] 在 `ConversationSidebar.module.css` 中统一复核工作台和学习入口 28px 行高、分区标题 `var(--text-xs)`/`var(--text-tertiary)` 以及固定导航、标题行、分组、底部按钮之间的垂直间距，必要时只调整本模块的间距。依赖：2.5、3.6、4.5、5.6、6.2；完成标准是在 100% 缩放、搜索关闭且准备至少 8 条数据的 760px 高窗口中，中文和英文对话模式均至少能看到 8 条完整对话行，其余内容可滚动，底部创建区和头像底栏不遮挡列表。

### 6.4 验证主题、窄窗口和减少动态效果
- [ ] 围绕 `ConversationSidebar.tsx` 与 `ConversationSidebar.module.css` 检查浅色/深色主题、桌面 244px 侧栏、860px 附近窄窗口及 `min(280px, 86vw)` 抽屉、系统减少动态效果。依赖：6.3；完成标准是胶囊颜色随主文字色适应且保持低强调，36px 高度、999px 圆角和左右 12px 不变形，内容不横向溢出，减少动态效果时不覆盖全局规则且按下/选中状态仍可辨识。

## 7. 同步清理废弃文案、样式和引用

### 7.1 在中英文资源中成对删除废弃键
- [ ] 全仓核对引用后，在 `frontend/src/lib/i18n/messages.ts` 的中英文资源中同时删除 `sidebar.quickActions`、`sidebar.addTask`、`sidebar.expandSpace`、`sidebar.collapseSpace`、`sidebar.noThreads`。依赖：2.4、3.4、5.4；完成标准是全仓不再引用这些键，不误删 `space.noOpenThreads`、仍被 `SubjectPicker` 使用的 `sidebar.spaces` 或与本次无关的历史未引用键，中英文键集合继续一致。

### 7.2 清理失效 CSS 和残留导入但不扩大重构
- [ ] 在 `ConversationSidebar.module.css` 与 `ConversationSidebar.tsx` 中清理不再引用的 `quickRow/quickButton/quickButtonActive`、`listToolbar/sortButton`、`threadItem`、`expandButton/expandChevron/expandChevronOpen`、`threadList`、空间展开相关样式、`spaceRowActive::before` 和旧按钮滤镜/图标导入。依赖：3.4、4.4、5.4、6.3；完成标准是删除前逐项确认无引用，保留仍被空间行、普通对话菜单、头像菜单、更新提示和删除确认使用的样式，不顺带重构无关组件。

### 7.3 核对最终引用和变更范围
- [ ] 检查四个限定业务文件的差异和全仓文本引用，确认侧栏无 `COMPOSE_TASK_EVENT`、展开状态、子支线和 `onOpenThread` 残留，日程 `onOpenThread` 与全局任务机制仍在；确认两个标题资源无 `{count}`、标题与数字为两个 `span`，创建时间路径的排序、对话分组和行尾时间均使用 `createdAt`，最近活动路径的对话使用 `updatedAt`、空间使用 `lastStudiedAt ?? updatedAt`，且各自排序、对话分组和行尾时间同源。依赖：7.1、7.2；完成标准是业务差异只涉及四个限定文件，`globals.css`、依赖清单、锁文件、共享时间函数和其它页面无变化，无 `any`、非空断言或跳过检查等规避手段。

## 8. 执行完整验收并记录结果

### 8.1 运行 TypeScript 静态检查并记录
- [ ] 在 `frontend/` 目录运行 `npx tsc --noEmit`，记录实际执行结果、退出码和诊断摘要。依赖：7.3；通过标准是退出码 0 且无 TypeScript 错误，重点覆盖中英文 `MessageKey`、删除属性无残留、组件回调、图标导出和可空时间处理；若失败，只在允许范围内修复本次引入问题并重跑，不得放宽类型或跳过脚本。

### 8.2 运行既有 API 测试并记录
- [ ] 在 `frontend/` 目录运行 `npm run test:api`，记录退出码、测试总数、通过/失败数量及失败摘要。依赖：8.1；通过标准是所有既有测试通过，数据契约无回归；若失败，区分基线问题与本次变更，修复本次引入项后重跑并保留最终结果。

### 8.3 运行生产构建并记录
- [ ] 在 `frontend/` 目录运行 `npm run build`，记录退出码和构建结果摘要。依赖：8.2；通过标准是 Next.js 生产构建成功，CSS Module、客户端组件和静态类型集成无新增错误；不得通过修改构建脚本或忽略错误获得通过。

### 8.4 执行核心功能回归矩阵
- [ ] 在浏览器中覆盖模式点击/重复点击/左右键、学习两入口、工作台三入口、标题与计数、排序菜单取消与选择、搜索清空/Escape、加载失败重试、对话打开/重命名/删除/生成态、空间单层导航/红点、底部两种创建行为及日程和对话添加任务。依赖：8.3；完成标准是所有结果符合第 2～6 项任务及规格中的既有反馈，模式切换、搜索、排序和菜单不新增网络请求或全量重载；若返工，重跑 8.1～8.3 中受影响的检查。

### 8.5 执行时间字段和相对时间边界验收
- [ ] 使用固定 `now` 和 `createdAt`/`updatedAt`/`lastStudiedAt` 明显不同的样例，分别验证对话与空间的两种排序；空间样例须覆盖 `lastStudiedAt` 与 `updatedAt` 先后关系相反、`lastStudiedAt` 为 `null`/`undefined` 的优先与回退场景，并覆盖空值/非法日期、30 分钟前、略晚于当前、当天 1/2 小时、昨天、跨日不足 7 天、满 7/14 天、跨月/跨年及本地夏令时边界。依赖：8.3；完成标准是创建时间模式下对话与空间的排序、对话分组和行尾时间均使用 `createdAt`；最近活动模式下对话使用 `updatedAt`，空间使用 `lastStudiedAt ?? updatedAt`，且同一对象的排序、对话分组和行尾时间使用同一时间值。英文单复数自然、对话与空间同时间文本一致、无负值或技术错误，切换语言后全部时间文本同步更新。

### 8.6 执行视觉、环境和既有辅助能力验收
- [ ] 在浅色/深色、中文/英文四种组合下检查选中态、计数层级、行尾稳定性、空间浅底无左竖条、红点与时间共存及胶囊计算样式；复核 760px 高窗口至少 8 条对话、侧栏收起/重开、860px 附近窗口、极窄抽屉、无悬停设备和减少动态效果，并验证头像菜单、更新提示、模型异常、主题、帮助、设置、资料和记忆。依赖：6.4、8.3；完成标准是无横向跳动、溢出、遮挡、原始翻译键或写死主题色，所有既有辅助能力及键盘核心导航保持可用。

### 8.7 汇总最终交付记录与验收结论
- [ ] 在后续实施阶段的最终交付说明中逐项记录 `npx tsc --noEmit`、`npm run test:api`、`npm run build` 的命令、退出码和结果摘要，以及功能、时间、视觉环境回归结论和未通过项跟进措施；列出实际变更文件。依赖：8.1～8.6；完成标准是三命令均有真实运行记录且全部通过，人工矩阵无未处理的本次回归，业务代码变更严格限于四个限定文件，未修改 `globals.css`、未新增依赖，四项本次确认调整均有明确验收结果。

---

**本轮待办（2026-11-18）：以下第 9～12 项是唯一需要执行的任务；第 1～8 项不得重复实施。**

## 9. 精简学习模式顶部入口

### 9.1 删除顶部重复的新建学习空间按钮
- [ ] 在 `frontend/src/components/chat/ConversationSidebar.tsx` 的 `mode === "learn"` 分支中，仅删除 `.learningShortcuts` 内调用 `props.onCreateSpace`、包含 `<Plus size={15} aria-hidden />` 和 `t("sidebar.newSpace")` 的第一个 `button.navRow` 完整节点；保留 `.learningShortcuts` 容器及其后的「全部学习空间」按钮，不改工作台、底部 `button.primaryAction` 或其它 JSX。依赖：无；完成标准是学习模式顶部只剩「全部学习空间」一行，`LayoutGrid`、`spacesActive`、`onOpenSpaces` 和 `aria-current` 均保留，`Plus`、`onCreateSpace` 与 `sidebar.newSpace` 仍供底部按钮使用，不删除图标导入、组件属性或文案键。

## 10. 校准对话时间分组名与每组上方间距

### 10.1 对齐分组名与对话标题并建立独立文字样式
- [ ] 在 `frontend/src/components/chat/ConversationSidebar.module.css` 中仅调整 `.groupHead` 的水平内边距和文字样式：保留 `margin: 0 -8px`，设置 `padding: 0 8px 0 16px`、`color: var(--text-tertiary)`、`font-size: 11px`、`font-weight: 400`、`letter-spacing: normal`；保留 `position: sticky`、`top: 0`、`z-index: 2`、flex 对齐、22px 高度和 `background: var(--bg-sidebar)`。依赖：9.1；完成标准是分组名与普通 `.itemTitle` 的文字左缘均位于滚动区内容坐标 X=16px，负外边距仍让吸顶背景覆盖全宽，`.listTitle`、`.listCount` 和 `.sectionTitle` 的字号、颜色、字重及行高不变。

### 10.2 统一首组及后续组的 8px 上方间距并清除旧规则
- [ ] 在同一 CSS 文件中把 `.group` 的 `padding-top` 从 0 调为 8px，不设置首组例外；完整删除 `.group + .group { margin-top: 2px; }`，并把 `.listHeader` 的 `margin-bottom` 从 2px 调为 0，避免首组出现 10px 叠加间距。不得给 sticky 的 `.groupHead` 增加上外边距、上内边距或高度补偿，不得改变 `.list` 的 1px 行间距、`.itemButton`/`.itemEnd` 的 32px 高度或滚动容器。依赖：10.1；完成标准是首组与列表标题之间、后续组与上一组最后一行之间均为 8px，旧 2px 规则无残留，组名吸附时仍位于滚动区顶部且高度为 22px。

## 11. 设置工作台与列表标题之间的 10px 纯间距

### 11.1 调整滚动区上外边距且不添加分隔线
- [ ] 在 `frontend/src/components/chat/ConversationSidebar.module.css` 中仅把 `.scroll` 的 `margin: 4px -8px 0` 改为 `margin: 10px -8px 0`，保持左右负外边距、内边距、`flex: 1`、`min-height: 0` 和 `overflow-y: auto` 不变；不得新增边框、阴影、`::before`/`::after` 或 `--border-subtle` 分隔线，也不改 `.topArea` 内部 gap、`.workspace` 间距、`.listHeader` 高度/内边距及标题文字样式（其下外边距仅按 10.2 调整）。依赖：10.2；完成标准是两种模式下工作台最后一行底边至 `.listHeader` 顶边均为约 10px，区间内只有空白，列表宽度、滚动行为和底部固定区域不变。

## 12. 执行本轮限定验收并记录结果

### 12.1 核对本轮差异与文件边界
- [ ] 在运行自动检查前核对本轮差异，确认业务改动只涉及 `ConversationSidebar.tsx` 的单个按钮删除，以及 `ConversationSidebar.module.css` 中 `.scroll`、`.listHeader`、`.group`、`.group + .group`、`.groupHead` 的目标调整；区分并保留工作区既有改动，不回退用户内容。依赖：11.1；完成标准是 `ChatApp.tsx`、`messages.ts`、`globals.css`、其它业务文件、依赖清单和锁文件均无本轮差异，未新增依赖或改动任何中英文文案键。

### 12.2 运行 TypeScript 静态检查
- [ ] 在 `frontend/` 目录运行 `npx tsc --noEmit`，记录真实命令结果、退出码和必要诊断摘要。依赖：12.1；通过标准是退出码 0 且无 TypeScript 错误；若 JSX 删除导致结构、导入或属性问题，只允许在两个限定文件内修复并重跑，不得使用 `any`、类型断言或跳过检查规避。

### 12.3 运行生产构建
- [ ] 在 `frontend/` 目录运行 `npm run build`，记录真实命令结果、退出码和构建摘要。依赖：12.2；通过标准是 Next.js 生产构建成功且无新增 CSS Module 或客户端组件错误；若失败，区分既有基线问题与本轮回归，只在允许范围内修复本轮引入项后重跑，不修改构建脚本、依赖或其它文件。

### 12.4 复核学习入口唯一性与工作台纯间距
- [ ] 在浏览器分别检查对话和学习模式：学习模式的模式切换器与工作台之间只能有「全部学习空间」，点击仍打开既有 `spaces` 视图；底部「新建学习空间」仍只打开一次既有创建对话框，成功、取消和失败反馈不变；对话模式不渲染学习快捷区。随后在两种模式测量工作台末行至列表标题行顶边的距离并检查该区间。依赖：12.3；完成标准是顶部无第二个创建入口，间距约 10px 且无分隔线，列表分区标题和工作台标题样式与本轮前一致。

### 12.5 复核分组文字对齐、8px 间距和 sticky 滚动
- [ ] 准备今天、昨天、本周等多个非空对话组，比较各 `.groupHead` 文本与普通对话标题文本的左缘，读取分组名计算样式，并分别测量首组及后续组上方区域；缓慢正反向滚动经过各组名，同时检查搜索有结果/无结果、清空及空态。依赖：12.4；完成标准是文字左对齐，颜色为 `--text-tertiary`、字号 11px、字重 400、正常字间距，每组上方均为 8px 且无旧 2px 叠加；sticky 顶部吸附、22px 高度、不透明全宽背景、组序、组内排序和原滚动行为不变，无分组时不产生多余空白，列表分区标题不变。

### 12.6 复核 760px 高窗口至少 8 条对话
- [ ] 在 100% 缩放、760px 高窗口、搜索关闭的条件下，准备至少 8 条属于同一「今天」分组的普通对话，分别以中文和英文检查首屏；继续滚动访问后续分组和记录。依赖：12.5；通过标准是两种语言均至少显示 8 条完整对话行，第 8 行底边位于 `.scroll` 可视底边内且不被底部创建区或头像区遮挡，更多内容可通过原纵向滚动访问；不得为凑够条数压缩已确认的 8px 间距、32px 对话行或改变列表标题样式，若不通过须如实记录并仅在限定 CSS 内修正。

### 12.7 复核既有侧栏交互与显示环境
- [ ] 对本轮可能波及的既有行为做精简回归：对话打开、悬停/聚焦、重命名和删除、生成态、排序与搜索，空间列表导航、红点及相对时间，以及浅色/深色主题、侧栏收起/重开、860px 附近窗口和极窄抽屉。依赖：12.6；完成标准是无新增横向溢出、文字遮挡、行尾跳动或不可达操作，底部胶囊按钮、滚动容器、焦点环和既有业务反馈不回归，空间列表不误用对话分组样式。

### 12.8 汇总本轮实际验收记录
- [ ] 在后续实施阶段的最终交付说明中列出实际变更文件，逐项贴出 `npx tsc --noEmit` 与 `npm run build` 的真实结果、退出码和必要摘要，并记录学习入口唯一性、分组对齐与间距、10px 纯间距、sticky/滚动及 760px 至少 8 条对话的验收结论和未通过项跟进措施。依赖：12.2～12.7；完成标准是两命令均实际执行且通过，人工复核无未处理的本轮回归，业务代码差异严格限于两个限定文件，未新增依赖或修改文案资源。