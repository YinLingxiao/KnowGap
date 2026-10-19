# QA-Agent-3 实测报告

隔离实例 `127.0.0.1:8003`，模型 `deepseek-flash`（`https://api.deepseek.com/v1`，真实 SSE，非 Mock）。数据库 `C:\Users\mfgyy\AppData\Local\Temp\opencode\qa_node_3\data\knowgap.sqlite3`。`ai-settings.json` 放在该库同级的 `data` 目录；加载器只读 sqlite 的父目录，因此没有使用任务书里写的 `qa_node_3\knowgap.sqlite3`（那个路径读不到 `data\ai-settings.json`）。未改业务源码，未访问 8000/8001/8002/8004。测完已停掉 8003。

空间 `subj-ee24b428e67345dba714a90bb3ad4032`《数据结构与算法》。10 轮都在同一 Thread `conv-211301ef5440421face4f5a569ba2844`。主对话角色是 `main`，不会挂 `feynman_challenge`，`resolve/draft` 也只接受 Thread，所以长会话放在 Thread 里。

读超时在进程环境里设为 120 秒（配置上限）。多轮在工具调用后的下一次模型连接返回 502「暂时无法连接模型服务」。失败且没有 `analysis` 时，实测脚本用产品接口 `POST /api/conversations/{id}/regenerate` 重试，最多 3 次。下表 TTFT / 总耗时取最终成功的那一次；失败次数写在备注里。第 3 轮三次都失败。

`learner_memories` 没有 `strength` 字段，升级看 `status` 和 `confidence`。计数器不在 `student_profiles`，在 `conversation_note_state.turns_since_note`。笔记接口是 `GET /api/agent-memory`，不是 `GET /api/agent/notes`。小结接口是 `POST /api/conversations/{id}/resolve/draft`。题库没有 `push-pop-trace`，第 3 轮用的是 `stack-sequence-001`（入栈 `[1,2,3]`，问能否得到 `[3,1,2]`，标准答案不可能）。

SSE `analysis` 事件体是落库后的 `{user_message, assistant_message}`，原始 `observations` 在分析模型的 JSON 里。下面每轮同时给出这段 JSON 和落库 quote。

## 1. 执行总览

| 轮 | 场景 | HTTP / SSE | TTFT ms | 总耗时 ms | 记忆状态 | 结果 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 误区首次暴露 | 200，`analysis`×1；前一次 502 | 12943 | 31508 | 新建 `栈的进出顺序`，`suspected`，quote 为原话子串 | Pass |
| 2 | 二次强化 | 200，`analysis`×1；前一次 502（已有 3153 字回复但未分析） | 9909 | 35245 | 同一条 evidence 1→2，`needs_review`，confidence 0.50→0.65；`to_review=1` | Pass |
| 3 | 诊断练习 | 练习 201 / 27 ms；对话三次失败 | — | 120129 | 无变化；`exercise_attempt` 未写入 | Fail |
| 4 | 正确推导弱化 | 200，`analysis`×1 | 19130 | 41371 | 原误区仍 `needs_review`；另建 mastery「出栈顺序由操作时机决定」 | Fail（弱化被丢弃） |
| 5 | 人工纠偏 | PATCH 200；对话 200，`analysis`×1 | 31373 | 60012 | 该条保持 `resolved` + `user_corrected=true`；计数被 memory 工具清零 | Pass（护栏未被触发改写） |
| 6 | 费曼第 1 回合 | 200，`analysis`×1 | 18242 | 39435 | `active_skill=feynman_challenge`；新建二分边界误区 `suspected` | Pass |
| 7 | 费曼第 2 回合 | 200，`analysis`×1；前两次 502 | 16657 | 32152 | 技能退回 `deep_explain`；二分误区仍 `suspected` | Partial |
| 8 | 费曼第 3 回合 + 小结 | 对话 200；`resolve/draft` 200 / 6866 ms | 15184 | 49503 | 新增 2 条 mastery；二分误区仍 `suspected`；小结 4 条 takeaway | Partial |
| 9 | 逼近阈值 | 200，`analysis`×1；中途拒绝了一次 `bash` | 22248 | 95088 | `turns_since_note=4`，不是 9 | Fail |
| 10 | 触发五层 Review | 200，`analysis`×1；等待 90 s 无 `review` | 25898 | 47321 | 计数停在 5；`_review()` 未跑；MEMORY 仍空 | Fail |

## 2. 逐轮档案

### 第 1 轮 误区首次暴露

输入：我刚学栈（Stack），我觉得栈就像排队买票一样，最先放进去的元素肯定最先被弹出来，也就是先进先出（FIFO）对吧？顺便记一下我是计算机系大二学生，正在准备秋招。

回复节选：先纠正一个关键方向：栈是「后进先出」，所以你这句话正好说反了。排队买票、先来先服务，那是队列（Queue），也就是 FIFO；栈的行为像叠盘子、电梯最后进来的人先出去、浏览器的后退，是 LIFO（Last In First Out）。我先用一个最小例子推一遍，再把它和队列放在同一个例子上对比。依次压入 1、2、3 之后，只能从栈顶弹出 3。

`turn_context.active_skill` 为 `deep_explain`。当时还没有 learner memory。

analysis observations：

```json
{"kind":"misconception","topic":"栈的进出顺序","effect":"reinforces","summary":"认为栈是先进先出（FIFO），把栈类比成排队买票","evidence":"我觉得栈就像排队买票一样，最先放进去的元素肯定最先被弹出来，也就是先进先出（FIFO）对吧","reason":"用户明确陈述了栈为先进先出的错误说法，并把栈与队列的排队模型混为一谈，属于典型的概念混淆。","related_memory_id":null}
```

Diff：`[]` → `lmem-8e1928cd28d54ac88ec3cb624259bfc9` kind=`misconception` status=`suspected` confidence=`0.5` evidence=`1`。quote 是第 1 轮原文的连续子串，并且故意没带上句尾的「？」，所以没被「问句不能当误区证据」滤掉。USER 笔记被当轮 `memory` 工具写成「身份：计算机系大二学生；长期目标：正在准备秋招（面试向的数据结构与算法学习）」。`turns_since_note=1`。空间 `to_review=1`。

### 第 2 轮 同一误区二次强化

输入：那如果把 1、2、3 依次压入栈，中间不弹出，最后连续 pop 三次的话，出来的顺序肯定也是 1、2、3 吧？因为 1 最先入栈呀。另外我平时喜欢看带图解和状态表格的讲解。

回复节选：这次的答案仍然是 3 → 2 → 1，并非 1 → 2 → 3。你推理里最关键的一句是「因为 1 最先入栈」，而这恰恰是它最后才出来的原因。下面用同一组 1、2、3 完整推演，观察每一步的栈状态。三次 push 完成后 1 在最底下，被 2 和 3 压住，第一次 pop 只能取出栈顶的 3。

注入的记忆只有 `lmem-8e1928…`，status 仍是 `suspected`。

```json
{"kind":"misconception","topic":"栈的出栈顺序","effect":"reinforces","summary":"依据“1 最先入栈”推断连续弹出顺序为 1、2、3，属于把 FIFO 直觉套用到栈上","evidence":"出来的顺序肯定也是 1、2、3 吧？因为 1 最先入栈呀","related_memory_id":"lmem-8e1928cd28d54ac88ec3cb624259bfc9"}
{"kind":"preference","topic":"讲解呈现方式偏好","effect":"reinforces","summary":"偏好带有图解和状态表格的讲解形式","evidence":"我平时喜欢看带图解和状态表格的讲解"}
```

Diff：没有新的栈误区。原记录 evidence 变为 2，status `suspected` → `needs_review`，confidence `0.50` → `0.65`。第二条 quote 也是原文连续子串。另建 preference「讲解呈现方式偏好」`observed`。`GET /api/subjects` 的 `progress.to_review=1`。USER 追加「讲解偏好：喜欢带图解和状态表格的讲解（逐步展示状态变化）」。`turns_since_note=2`。

### 第 3 轮 诊断练习

`POST /api/conversations/{id}/exercises` `{"problem_id":"stack-sequence-001"}` → 201，27 ms，`active_problem_id=stack-sequence-001`。

输入：我来做这道栈序列题。先把 1、2、3 依次压入，再弹出 3，这一步是对的，因为此时 3 在栈顶。接下来我认为可以直接弹出 1，然后再弹出 2，理由是 1 比 2 更早入栈，所以出栈序列 3、1、2 合法。

三次生成都没有首字：502 / 112120 ms，502 / 9325 ms，504 超时 / 120129 ms。回复长度为 0，没有 `analysis`，用户消息 `meta` 里没有 `attempt`。

失败前的 `turn_context` 已经同时带上了两样东西：`active_exercise.id=stack-sequence-001`，以及 `learner_memories` 中 status=`needs_review` 的栈误区。注入发生了，作答判定没有落库。记忆表与 `turns_since_note=2` 都没变。

### 第 4 轮 独立正确推导

输入：我想通了！栈只有一个栈顶出入口，遵循后进先出（LIFO）。当 1、2、3 依次入栈后，3 在栈顶，所以连续 pop 三次出来的顺序必然是 3、2、1，要让 2 最先出来就必须在压入 1、2 后先 pop 出 2，再压入 3！

回复节选：你这次的三点判断都成立，尤其关键的是「要让 2 最先出，就必须先 pop 出 2、再压入 3」这一句。这已经不是背结论，而是抓住了时间窗口：3 一旦入栈就会盖住 2，窗口关闭。我沿你的正确部分继续推，把它变成一条可判定的规则。只补一个细节：让 2 最先出的路径不唯一。

注入记忆仍是那条 `needs_review` 误区，练习题上下文还在。

```json
{"kind":"mastery","effect":"weakens","topic":"栈的后进先出特性","related_memory_id":"lmem-8e1928cd28d54ac88ec3cb624259bfc9","evidence":"栈只有一个栈顶出入口，遵循后进先出（LIFO）。当 1、2、3 依次入栈后，3 在栈顶，所以连续 pop 三次出来的顺序必然是 3、2、1"}
{"kind":"mastery","effect":"reinforces","topic":"出栈顺序由操作时机决定","evidence":"要让 2 最先出来就必须在压入 1、2 后先 pop 出 2，再压入 3"}
```

Diff：原误区仍是 `needs_review`，evidence 仍是 2，confidence 仍是 0.65。新 mastery「出栈顺序由操作时机决定」`observed`。第一条 `weakens` 没写上：模型把 kind 标成 `mastery`，却把 `related_memory_id` 指到 misconception。落库按 kind 找记录，对不上就丢掉这条反证，不会把误区改成 `improving` / `resolved`。`turns_since_note=3`。`mastered` 从 0 变成 1，`to_review` 仍是 1。

### 第 5 轮 人工纠偏

`PATCH /api/learner-memories/lmem-8e1928cd28d54ac88ec3cb624259bfc9` `{"status":"resolved"}` → 200。返回 `user_corrected=true`，status=`resolved`。

输入：栈和队列可以混在一道题里：队列是队头出、队尾进，栈是栈顶进出。我习惯用 C++ STL 的 `std::stack` 和 `std::queue` 写题，计划下个月底前刷完 100 道核心题。

回复节选：你说的这两点都准确：队列是队头出、队尾进（双开口）；栈是只从栈顶一端进出（单开口）。这正是混搭题能成立的原因。两者的开口方向不同，混搭题本质上要么让一种结构去模拟另一种语义，要么在同一道题里分工。为了不重复你已掌握的栈操作，直接看最典型的混搭题：用两个栈实现队列。同一批数据被压入两次，栈顶方向反转一次。

本轮注入里，那条误区已经是 `resolved`。本轮 analysis 只新增了 mastery「队列与栈的进出端」和 preference「C++ STL 刷题工具偏好」，没有对已纠偏记录发出 `reinforces`。该记录之后直到第 10 轮都保持 `resolved` 且 `user_corrected=true`，没有被改回 `suspected`。

本轮 `memory` 工具写入「先验技能：C++ STL 容器（惯用 std::stack 与 std::queue 写题）」，工具回执以「已更新」开头，计数被清零：`turns_since_note` 从 3 变成 0。`to_review` 变成 0（resolved 不再计入）。

### 第 6 轮 费曼第 1 回合

输入：我想用费曼学习法自测二分查找：你来当挑刺的面试官听我讲。我的理解是：只要数组有序，每次算 `mid = (left + right) / 2`，如果 `nums[mid] < target` 就令 `left = mid`，如果 `nums[mid] > target` 就令 `right = mid`，循环条件写 `while (left <= right)` 就行了。

`active_skill` 两次模型调用都是 `feynman_challenge`。

回复节选：你这套拆解骨架是对的，我先记下你讲对的地方：前提抓的是数组有序；每次取中点再用 `nums[mid]` 和 `target` 三分支，这是二分的核心结构；`while (left <= right)` 只有在把 `[left, right]` 当作闭区间时才自洽。但作为面试官，我卡在你给的两行更新规则上。先别急着解释，我们拿一个只有两个元素的最短例子来检验：`nums = [1, 3]`，`target = 3`。到此为止，这个区间没缩小一格。现在轮到你了，我只问一个问题：下一轮循环的 `mid` 是多少？这个循环会怎么结束？答的时候顺带说清两件事：一是为什么 `left = mid` 在这里没能把 `mid` 往右推，二是你打算怎么改——改哪一行、为什么改完就不会停不下来。

没有给出完整二分函数。追问钉在两元素、`left = mid`、区间不缩小、循环停不下来。原文用的是「停不下来」，没有直接写出「死循环」三个字。

```json
{"kind":"misconception","topic":"二分查找的边界更新","effect":"reinforces","summary":"认为 nums[mid] 与 target 比较后应令 left = mid 或 right = mid（而不是 mid±1），且与 while(left <= right) 搭配","evidence":"如果 `nums[mid] < target` 就令 `left = mid`，如果 `nums[mid] > target` 就令 `right = mid`，循环条件写 `while (left <= right)` 就行了"}
```

落库 quote 被收成「如果 `nums[mid] < target` 就令 `left = mid`，如果 `nums[mid] > target` 就令 `right = mid`」，仍是原文连续子串。新记录 `lmem-60f29979…` status=`suspected`。栈误区仍是 `resolved`。`turns_since_note=1`。

### 第 7 轮 费曼第 2 回合

输入：你说得对，如果 `left=2, right=3`，`mid` 向下取整还是 `2`，令 `left=mid` 就会原地死循环！所以在闭区间 `[left, right]` 下，既然 `nums[mid]` 已经明确小于 `target` 了，就应该排除掉 `mid`，写成 `left = mid + 1`，同理右边写成 `right = mid - 1`。

本轮用户句没有「费曼 / 挑刺 / 听我讲」，`active_skill` 退回 `deep_explain`。前两次生成在工具回合后 502，成功的是第三次。

回复节选：修正得干净利落，而且说到了根上：`mid` 向下取整时 `left = mid` 可能原地不动，`left = mid + 1` 才保证区间每轮至少缩一格。这就是循环必然终止的理由。用你的修正重跑 `nums=[1,3], target=3`：原规则结局是死循环，修正后返回 1。`left <= right` 与 `mid ± 1` 是一对。我埋的第二个坑是 `(left + right) / 2`：两个下标相加在数组足够大时会先溢出。安全写法是 `mid = left + (right - left) / 2`。

闭区间排除 `mid` 被肯定了，返回值（返回 1）和加法溢出都追到了。溢出的改法是模型先讲出来的，不是只追问。

analysis 把纠正标成 `kind=mastery, effect=weakens`，`related_memory_id` 指向二分误区。和第 4 轮一样被丢掉。该误区仍是 `suspected`，evidence 仍是 1。`turns_since_note=2`。

### 第 8 轮 费曼第 3 回合与 Thread 小结

输入：为防止大整数相加溢出，应该写 `mid = left + (right - left) // 2`；当循环因 `left > right` 结束时，说明闭区间已空，返回 -1。我还总结了一条经验：写二分前先锁定循环不变量是左闭右闭还是左闭右开。

技能仍是 `deep_explain`。

回复节选：你这三句里有两点判断是完全正确的，第三点（先锁不变量）已经符合有经验的工程师的判断习惯，不只是背诵结论。下面按你给出的三条线索继续推导：用 `[1,3,5,7]`、`target = 6` 这个找不到的例子跑完闭区间。第三轮比较后 `right = 2`，区间变成 `[3,2]`，`left > right`，返回 -1。这正好验证了你那句话：在闭区间不变量下，区间为空的表现就是 `left > right`。

模型肯定了结论，并继续把半开区间讲完，不是停在一句祝贺上。

新 mastery：「二分查找的溢出安全 mid 与闭区间终止条件」「先锁定循环不变量再写二分」，都是 `observed`。二分边界误区仍是 `suspected`。`turns_since_note=3`。`mastered=5`，`to_review=1`（只剩这条二分误区）。

`POST /api/conversations/conv-211301ef5440421face4f5a569ba2844/resolve/draft` → 200，6866 ms。

```json
{"title":"栈的出栈顺序与二分查找的边界修正","summary":"学习者起初以为 1、2、3 依次入栈后连续 pop 会得到 1、2、3，并在「3、1、2 是否合法」的练习中延续了这个误解；随后自己推出栈只有一个栈顶出入口、遵循后进先出，并指出要让 2 最先出就必须赶在 3 入栈前先 pop 出 2。接着对比了栈与队列的开口方向差异，理解了两个栈模拟队列的机制。在二分查找上，学习者初版写 left = mid / right = mid，在两元素例子上暴露了区间不缩、原地死循环的问题，修正为 mid ± 1，并补充了防溢出的 mid 写法以及写二分前先锁定循环不变量的习惯。","takeaways":["栈只从栈顶一端进出，1、2、3 依次入栈后连续 pop 得到 3、2、1，序列 3、1、2 不合法。","出栈顺序取决于时间窗口：想让某个元素先出，必须在后续元素压入盖住它之前弹出。","闭区间二分中 nums[mid] 已确定不等于 target，应写 left = mid + 1、right = mid - 1，否则 mid 向下取整会让区间不缩小而陷入死循环。","mid 写成 left + (right - left) / 2 可防大整数相加溢出，写二分前应先确定循环不变量是左闭右闭还是左闭右开。"]}
```

小结是多句结构化叙述，takeaways 4 条，在 2～4 的上限上。`message_id` 为 null，草稿没有写回消息。

### 第 9 轮 计数器

输入：接下来我们聊聊递归调用栈与系统栈溢出的关系。顺便提一句，我非常喜欢先看调用栈帧的每步入栈出栈变化图，而且我们项目的代码都放在工作区的 `src/algorithms` 目录下。

回复节选：既然你喜欢先看帧的进出，我就从调用时栈上到底发生了什么讲起，用同一个 `fact(3)` 走完每一次入栈和出栈，最后再用数字算出什么时候会溢出。我没有读取 `src/algorithms`，因为你没有批准这次目录访问，所以下面先不依赖你的实际代码。每次函数调用都会在调用栈上压入一个栈帧，帧里装着参数 `n`、局部变量、以及返回到调用者的哪一行。`main` 的帧一直在栈底。

中途出现 `tool_approval`，工具是 `bash`，命令是探测 `src/algorithms`。实测脚本拒绝了这次审批（否则会空等 600 秒），模型于是声明没有读目录。本轮 analysis 没有新的 learner memory。`turns_since_note=4`，不是 9。没到 9 是因为：第 3 轮失败没计数，第 5 轮 memory 工具成功写入把计数清零，之后只累加了第 6～9 轮。

### 第 10 轮 后台 Review

输入：我明白了，每次函数递归调用都会在调用栈上压入一个新的栈帧保存局部变量和返回地址，如果没有基准终止条件（Base Case）就会触发 StackOverflowError。

回复节选：你这句总结里前半句是对的，后半句的因果关系不成立。每次递归调用都会压入新栈帧，帧里存局部变量和返回地址，这句话可以放心讲出去。关键错误是「如果没有 base case 就溢出」不成立：base case 写得完全正确，链状递归 DFS 照样会把帧一路堆到栈顶。最后一条是术语：`StackOverflowError` 是 Java 的异常名，不是这段 C++ 讨论里该用的词。

```json
{"kind":"misconception","topic":"爆栈的成因（必要条件与充分条件混淆）","evidence":"如果没有基准终止条件（Base Case）就会触发 StackOverflowError。","summary":"认为缺少基准终止条件才会导致栈溢出，把 base case 当成了爆栈的必要原因"}
{"kind":"misconception","topic":"StackOverflowError 的适用语言","evidence":"就会触发 StackOverflowError。","summary":"在 C++ 语境中把栈溢出说成会抛 StackOverflowError，混用了 Java 的异常术语"}
```

两条都新建为 `suspected`。已纠偏的栈 FIFO 记录没有被碰。`to_review` 从 1 变成 3。`turns_since_note=5`。

流结束后每 5 秒查一次，共 90 秒。`complete_json` 里 purpose=`review` 的次数一直是 0。`GET /api/agent-memory` 相对第 9 轮没有变化。

结束时 USER：

```text
身份：计算机系大二学生；长期目标：正在准备秋招（面试向的数据结构与算法学习）
§
讲解偏好：喜欢带图解和状态表格的讲解（逐步展示状态变化）
§
先验技能：C++ STL 容器（惯用 std::stack 与 std::queue 写题）
```

MEMORY 为空。这些条是对话中 `memory` 工具写的，不是第 10 轮 `_review()` 写的。前缀里有「讲解偏好：」「先验技能：」。没有「阶段目标：」「经验法则：」，也没有 `src/algorithms` 这条环境事实。「长期目标：」接近阶段目标，但不是任务书写的那个前缀，而且出现在第 1 轮，不是第 10 轮。

## 3. 问题

1. 工具回合之后的下一次 DeepSeek 流经常直接 502，整轮被标成 `failed`，已流出的正文作废，`analysis` 和 `note_turns` 都不跑。第 1、2、3、7 轮都中过。第 3 轮连首字都没有，诊断题的 `exercise_attempt` 整段缺失。
2. `weakens` 必须 `kind` 与目标记忆一致。模型两次用 `mastery + weakens + related_memory_id=<misconception>`，反证被静默丢掉。栈误区要靠人工 PATCH 才变成 `resolved`；二分误区在用户已经改对之后仍是 `suspected`，`to_review` 因此一直挂着。
3. `user_corrected` 没有写在 `record_observation` 里，只写在分析提示词里。这次模型没有对已纠偏记录再发 `reinforces`，所以状态没被改回去。代码路径本身仍会按证据重算 status。
4. `memory` 工具只要回执以「已更新」开头，就把 `turns_since_note` 清零。10 轮对话结束时计数是 5，`_review()` 不会在第 10 轮启动。五层笔记若只靠这个后台任务，就会被中途的身份/偏好写入无限期推迟。
5. `feynman_challenge` 只看当前句有没有「费曼 / 挑刺 / 听我讲」。第 6 轮挂上了，第 7、8 轮同一自测的后手自动掉回 `deep_explain`，模型开始直接讲溢出写法和半开区间。
6. 问句过滤器只看 quote 结尾。模型把「对吧？」的问号裁掉后，误区可以落库。这是实测里的规避，不是过滤器失效，但边界很窄。
7. 契约和任务书不一致：笔记是 `/api/agent-memory`，小结是 `/api/conversations/{id}/resolve/draft`，计数在 `conversation_note_state`，练习 id 是 `stack-sequence-001`。`resolve/draft` 的 `message_id` 为 null。
8. 第 9 轮模型要执行 `bash` 列出 `src/algorithms`。审批被实测脚本拒绝后，路径没有进 MEMORY。即便审批通过，这个事实也更该由笔记写入，而不是先跑一段目录命令。
