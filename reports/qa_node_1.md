# QA-Agent-1 · KnowGap 十轮端到端实测报告

- 测试时间：主测 2026-10-19T14:31:56Z → 14:34:07Z；认证演示模式复测与 R9 派发 Thread 补测在 14:35–14:39Z 完成
- 服务端点：`http://127.0.0.1:8001`（全程仅使用 8001；未触碰 8000/8002/8003/8004）
- 隔离数据库：`C:\Users\mfgyy\AppData\Local\Temp\opencode\qa_node_1\knowgap.sqlite3`（独立文件，未写入开发库）
- 真实模型：`deepseek-flash`，读取 `backend/data/ai-settings.json`，真实 SSE 流式调用，无 Mock
- 测试账号：`qa_agent1@test.local`
- 采集方式：在沙盒进程内启动 uvicorn（8001），仅在运行时包装 `app.chat.service.chat_messages`，原样记录注入模型的 `turn_context`；未修改任何业务源码。
- 数据口径：单轮 Token 取该轮被测会话的 `/usage` 前后差值；SQLite Diff 为全库业务表差值（因此会包含主对话自动派发的 Thread 与后台分析产生的写入）。

## 1. 执行总览表

| 轮次 | 场景 | HTTP / SSE | TTFT (ms) | 总耗时 (ms) | Token（入/出） | 结果 |
|---|---|---|---|---|---|---|
| 1 | 邮箱验证码认证闭环与多租户隔离建档 | send-code 502 / register 201 / me 200 / login 200、422 | — | — | — | **Fail** |
| 2 | 三问三答初识引导访谈（Onboarding）与候选画像原话证据抽取 | 200 / 200 / 200；complete 200 | 38 / 44 / 38（首事件） | 12745 | 1009 / 625 | Pass |
| 3 | LobeHub 五层白盒用户记忆写入与分类核验 | PUT 200 / GET 200 | — | — | — | **Fail** |
| 4 | 零先验状态下的主动先验探针（场景 A） | 200 / SSE 完整 | 11422 | 11870 | 9480 / 657 | Pass |
| 5 | 智能灰字追问补全与内存缓存实测 | 200 / 无 SSE | — | 10 + 10 | — | **Fail** |
| 6 | 口头自述旧知 → 自动识别并触发对比迁移（场景 B） | 200 / SSE 完整 | 12516 | 13025 | 11569 / 1086 | **Fail** |
| 7 | Thread 执行层 C++ → Python 对比迁移 + comparison_matrix 微件 | 200 / SSE 完整 | 39542 | 51127 | 18462 / 9671 | Pass |
| 8 | 跨语言负迁移防坑拦截与 micro_quiz 实测 | 200 / SSE 完整 | 11662 | 17368 | 12322 / 3210 | Pass |
| 9 | 多学科先验锚点叠加与跨空间复用（数学 + 编程） | 200 / SSE 完整 | 11462 | 12063 | 9745 / 705 | Pass |
| 10 | 先验技能边界防误判（假设句 / 疑问句不误记） | 200 / SSE 完整 | 5000 | 6249 | 5187 / 316 | Pass |

**被测会话合计**：16 次计费请求，输入 67774 tokens，输出 16270 tokens。
**账号全量（含自动派发 Thread、后台分析与复盘）**：27 次请求，输入 152580 tokens，输出 25411 tokens，命中缓存 111488 tokens。

> 注：第 2 轮为单次落库回复（无 delta），TTFT 记为首个 SSE 事件 `start` 的到达时间，真实完成耗时见总耗时列。

## 2. 逐轮详实遥测档案（Round 1 ~ Round 10）

### 第 1 轮 · 邮箱验证码认证闭环与多租户隔离建档

**结果：Fail**（PARTIAL）

> 生产 SMTP 路径返回 502；演示模式下认证闭环全部通过。另发现“缺省 code 即可注册”的绕过路径与无 Token 回落 demo 学生。

**【输入原文】**

```http
POST /api/auth/send-code  {email: qa_agent1@test.local, purpose: register}
POST /api/auth/register    {email, password, code}
GET  /api/auth/me          (Bearer token)
POST /api/auth/login       {email, password}
POST /api/auth/login       {email, code}
GET  /api/conversations    (无 Token / 伪造 Token)
```

**【认证与隔离关键结果】**

```json
{
  "auth_rows": {
    "users": [
      {
        "id": "user-108820235ee58ed3",
        "username": "qa_agent1@test.local",
        "display_name": "QA Agent 1",
        "created_at": "2026-10-19T14:31:58+00:00"
      }
    ],
    "sessions": [
      {
        "user_id": "user-108820235ee58ed3",
        "created_at": "2026-10-19T14:31:58+00:00",
        "expires_at": "2026-11-18T14:31:58+00:00"
      },
      {
        "user_id": "user-108820235ee58ed3",
        "created_at": "2026-10-19T14:31:58+00:00",
        "expires_at": "2026-11-18T14:31:58+00:00"
      }
    ]
  },
  "isolation": {
    "no_token": {
      "status": 200,
      "count": 0
    },
    "invalid_token": {
      "status": 401,
      "body": {
        "detail": "登录已过期，请重新登录。"
      }
    }
  }
}
```

**【AI 真实回复原文节选】**

本轮无模型调用。接口返回如下：
```json
{
  "me": {
    "status": 200,
    "body": {
      "user": {
        "id": "user-108820235ee58ed3",
        "username": "qa_agent1@test.local",
        "display_name": "QA Agent 1",
        "avatar_text": "Q",
        "avatar_url": "",
        "provider": "email",
        "created_at": "2026-10-19T14:31:58+00:00"
      },
      "onboarding": {
        "status": "not_started",
        "onboarded": false,
        "conversation_id": null,
        "draft": {},
        "version": 0,
        "stage": "background",
        "ready": false,
        "has_user_profile": false
      }
    }
  },
  "login_password_user": {
    "id": "user-108820235ee58ed3",
    "username": "qa_agent1@test.local",
    "display_name": "QA Agent 1",
    "avatar_text": "Q",
    "avatar_url": "",
    "provider": "email",
    "created_at": "2026-10-19T14:31:58+00:00"
  },
  "login_code": {
    "status": 422,
    "user": null
  }
}
```

**【微件 JSON 校验 / 灰字预测原文】**

本轮不涉及微件或灰字预测。

**【SSE 事件序列与实时延迟】**

本轮为普通 REST 调用，无 SSE。

**【SQLite 数据库状态 Diff】**

```json
{
  "auth_sessions": {
    "before": 0,
    "after": 2,
    "delta": 2
  },
  "email_verification_codes": {
    "before": 0,
    "after": 1,
    "delta": 1
  },
  "users": {
    "before": 0,
    "after": 1,
    "delta": 1
  }
}
```

**补充复测：关闭 SMTP 后的演示验证码闭环（独立沙盒库）**

```json
{
  "send_code": {
    "status": 200,
    "body": {
      "sent": true,
      "delivery": "demo",
      "demo_code": "922449",
      "expires_in": 300
    }
  },
  "register_wrong_code": {
    "status": 400,
    "body": {
      "detail": "邮箱验证码不正确。"
    }
  },
  "register_correct_code": {
    "status": 201
  },
  "login_send_code": {
    "status": 200,
    "body": {
      "sent": true,
      "delivery": "demo",
      "demo_code": "538499",
      "expires_in": 300
    }
  },
  "login_by_code": {
    "status": 200
  },
  "login_by_password": {
    "status": 200
  },
  "me": {
    "status": 200
  },
  "isolation_no_token": {
    "status": 200,
    "count": 0
  },
  "isolation_bad_token": {
    "status": 401,
    "body": {
      "detail": "登录已过期，请重新登录。"
    }
  },
  "register_without_code": {
    "status": 201,
    "body_keys": [
      "token",
      "user",
      "onboarding"
    ]
  }
}
```

**【断言明细】**

```json
{
  "send_code_returns_code": false,
  "register_201_with_token": true,
  "me_matches_account": true,
  "password_login_200": true,
  "code_login_200": false,
  "invalid_token_401": true
}
```

### 第 2 轮 · 三问三答初识引导访谈（Onboarding）与候选画像原话证据抽取

**结果：Pass**（PASS）

> 3 轮访谈的 quote 均逐字命中用户输入，stage 依次 background → explanation → interaction → ready，complete 写入 3 条 USER 画像。

**【输入原文】**

```text
Turn 2.1：我目前是大二理工科学生，平时主要学编程和数学，目标是准备算法竞赛和期末考。

Turn 2.2：讲新概念时我最讨厌一上来就堆满公式定义，我喜欢先看一个直观的现实例子或动画推演，再看严谨公式。

Turn 2.3：我贴出半截代码或思路时，请先顺着我的思路指出卡点，不要直接把完整标准答案糊我脸上。
```

**【`turn_context` 关键字段真实 JSON 节选】**

（本轮未捕获到 turn_context。）

**【AI 真实回复原文节选】**

Turn 2.1（stage=explanation，quote 命中=True）：

接触新概念时，怎样讲你更容易理解？例如先看例子、对比结论，或逐步推导；也可以说暂时不确定。

Turn 2.2（stage=interaction，quote 命中=True）：

遇到卡点或练习时，你希望我怎样配合？例如先给提示、直接解析，或由你决定是否练习。

Turn 2.3（stage=None，quote 命中=True）：

谢谢，下面是我整理的候选画像。请核对或修改后确认；确认前不会写入长期画像。


**【微件 JSON 校验 / 灰字预测原文】**

本轮不涉及微件或灰字预测。

**【SSE 事件序列与实时延迟】**

- Turn 2.1：首事件 `38` ms / 总耗时 `4207` ms；`start → done`
- Turn 2.2：首事件 `44` ms / 总耗时 `4197` ms；`start → done`
- Turn 2.3：首事件 `38` ms / 总耗时 `4341` ms；`start → done`

**【SQLite 数据库状态 Diff】**

```json
{
  "agent_memory": {
    "before": 0,
    "after": 1,
    "delta": 1
  },
  "agent_state": {
    "before": 0,
    "after": 1,
    "delta": 1
  },
  "conversation_messages": {
    "before": 0,
    "after": 7,
    "delta": 7
  },
  "conversations": {
    "before": 0,
    "after": 1,
    "delta": 1
  },
  "model_usage": {
    "before": 0,
    "after": 3,
    "delta": 3
  },
  "onboarding_sessions": {
    "before": 0,
    "after": 1,
    "delta": 1
  }
}
```

```text
写入后 USER：
背景与目标：大二理工科学生，平时主要学习编程和数学，目标是准备算法竞赛和期末考
§
讲解偏好：讲新概念时不喜欢一上来堆公式定义，偏好先看直观现实例子或动画推演，再看严谨公式
§
互动偏好：贴出半截代码或思路时，希望先顺着其思路指出卡点，不要直接给出完整标准答案
```

```json
{
  "pre_complete_state": {
    "status": "in_progress",
    "stage": null,
    "version": 3,
    "ready": true,
    "onboarded": false
  },
  "complete_http": 200,
  "complete_response": {
    "status": "completed",
    "onboarded": true,
    "stage": null,
    "ready": true
  }
}
```

### 第 3 轮 · LobeHub 五层白盒用户记忆写入与分类核验

**结果：Fail**（PARTIAL）

> 五层标签与标准前缀全部落库，非偏好条目未混入 teaching_preferences；断言失败的原因是偏好条目重复（onboarding 已有 2 条，写入后又新增 2 条），并非分类错误。

**【输入原文】**

```text
[Identity] 常学领域：编程与数学（算法竞赛与期末复习并行）
§
[Preference] 讲解偏好：先看直观例子或动画推演，再看严谨公式，讨厌一上来堆公式定义
§
[Preference] 互动偏好：贴出半截代码时先顺着我的思路指出卡点，不要直接给完整标准答案
§
[Context] 阶段目标：准备算法竞赛和期末考
§
[Context] 背景约束：大二理工科在读，编程与数学是主线课程
§
[Activity] 近期动态：本周集中准备算法竞赛与期末复习
§
[Experience] 经验法则：先复现最小可运行例子再抽象公式，理解更稳
```

**【记忆分类关键结果】**

```json
{
  "note": "本轮为笔记写入，未发起对话，故无 turn_context。",
  "teaching_preferences": [
    {
      "source": "USER",
      "summary": "讲解偏好：讲新概念时不喜欢一上来堆公式定义，偏好先看直观现实例子或动画推演，再看严谨公式"
    },
    {
      "source": "USER",
      "summary": "互动偏好：贴出半截代码或思路时，希望先顺着其思路指出卡点，不要直接给出完整标准答案"
    },
    {
      "source": "USER",
      "summary": "[Preference] 讲解偏好：先看直观例子或动画推演，再看严谨公式，讨厌一上来堆公式定义"
    },
    {
      "source": "USER",
      "summary": "[Preference] 互动偏好：贴出半截代码时先顺着我的思路指出卡点，不要直接给完整标准答案"
    }
  ]
}
```

**【AI 真实回复原文节选】**

本轮无模型调用；写入后的 USER 笔记全文如下：
```text
背景与目标：大二理工科学生，平时主要学习编程和数学，目标是准备算法竞赛和期末考
§
讲解偏好：讲新概念时不喜欢一上来堆公式定义，偏好先看直观现实例子或动画推演，再看严谨公式
§
互动偏好：贴出半截代码或思路时，希望先顺着其思路指出卡点，不要直接给出完整标准答案
§
[Identity] 常学领域：编程与数学（算法竞赛与期末复习并行）
§
[Preference] 讲解偏好：先看直观例子或动画推演，再看严谨公式，讨厌一上来堆公式定义
§
[Preference] 互动偏好：贴出半截代码时先顺着我的思路指出卡点，不要直接给完整标准答案
§
[Context] 阶段目标：准备算法竞赛和期末考
§
[Context] 背景约束：大二理工科在读，编程与数学是主线课程
§
[Activity] 近期动态：本周集中准备算法竞赛与期末复习
§
[Experience] 经验法则：先复现最小可运行例子再抽象公式，理解更稳
```

**【微件 JSON 校验 / 灰字预测原文】**

```json
{
  "teaching_preferences": [
    {
      "source": "USER",
      "summary": "讲解偏好：讲新概念时不喜欢一上来堆公式定义，偏好先看直观现实例子或动画推演，再看严谨公式"
    },
    {
      "source": "USER",
      "summary": "互动偏好：贴出半截代码或思路时，希望先顺着其思路指出卡点，不要直接给出完整标准答案"
    },
    {
      "source": "USER",
      "summary": "[Preference] 讲解偏好：先看直观例子或动画推演，再看严谨公式，讨厌一上来堆公式定义"
    },
    {
      "source": "USER",
      "summary": "[Preference] 互动偏好：贴出半截代码时先顺着我的思路指出卡点，不要直接给完整标准答案"
    }
  ],
  "non_preference_leaked": []
}
```

**【SSE 事件序列与实时延迟】**

本轮为普通 REST 调用，无 SSE。

**【SQLite 数据库状态 Diff】**

```json
{}
```


**【断言明细】**

```json
{
  "put_status": 200,
  "all_five_layers_present": true,
  "preference_count": 4,
  "no_non_preference_leak": true,
  "no_prior_skill_yet": true
}
```

### 第 4 轮 · 零先验状态下的主动先验探针（场景 A）

**结果：Pass**（PASS）

> 主对话正确注入先验探针并主动询问 C/C++/Java；实际讲解被主协调器派发到 Thread（4115 字），主对话回复仅作派发说明。

**【输入原文】**

```text
我想从零开始系统搞懂 Python 的变量赋值、引用传递和可变默认参数
```

**【`turn_context` 关键字段真实 JSON 节选】**

```json
{
  "latest_user_message": "我想从零开始系统搞懂 Python 的变量赋值、引用传递和可变默认参数",
  "prior_knowledge_anchors": [],
  "reported_prior_knowledge": null,
  "transfer_learning_hint": "【迁移学习先验探针】当前尚不清楚用户的先验技能锚点。请在回应的同时，主动用 1 句话询问用户之前是否学过相近的语言或前置课程（例如学 Python 问是否会 C/C++），以便后续用对比迁移法教学；若用户告知已掌握某技能，请调用 `memory` 工具以 `先验技能：xxx` 格式记入 USER。",
  "teaching_preferences": [
    {
      "source": "USER",
      "summary": "讲解偏好：讲新概念时不喜欢一上来堆公式定义，偏好先看直观现实例子或动画推演，再看严谨公式"
    },
    {
      "source": "USER",
      "summary": "互动偏好：贴出半截代码或思路时，希望先顺着其思路指出卡点，不要直接给出完整标准答案"
    },
    {
      "source": "USER",
      "summary": "[Preference] 讲解偏好：先看直观例子或动画推演，再看严谨公式，讨厌一上来堆公式定义"
    },
    {
      "source": "USER",
      "summary": "[Preference] 互动偏好：贴出半截代码时先顺着我的思路指出卡点，不要直接给完整标准答案"
    }
  ],
  "recommended_widget": "micro_quiz（建议在回复中嵌入 ```knowgap-widget 的 micro_quiz 随堂微测卡）",
  "active_skill": "【当前挂载 Skill：deep_explain（深度原理精讲）】\n按以下工作流开展本次原理精讲，并结合 turn_context.teaching_preferences 与 USER 画像动态调整：\n1. 开场直奔主线：先用一句话交代讲解脉络（例如：“我先从为什么需要 X 讲起，再通过同一个具体例子逐个对比。”），不要客套寒暄。\n2. 步骤可视化：在展开正文前，先调用一次 `plan_steps` 工具列出 3 个清晰步骤（例如：① 设计贯穿全文的具体小例子 `[completed]`、② 构建交互微件逐步对比核心机制 `[in_progress]`、③ 提炼一句话本质与自测切口 `[pending]`）。\n3. 贯穿全文的最小例子 + 强制内联交互微件：构造 1 个极简、具体的例子，后续所有概念对比都在这**同一个例子**上演绎；**本轮必须在正文中嵌入至少 1 个 `knowgap-widget` 交互微件**（优先按 …（截断，原长 2240 字）"
}
```

**【AI 真实回复原文节选】**

主对话回复（派发说明）：

    好的，我已经安排了一个 Thread，会带你从直观例子入手，梳理变量赋值、引用传递和可变默认参数。
    
    另外想确认一句：你之前是否学过 C/C++、Java 这类语言？如果有，Thread 里会用对比的方式讲 Python 在这几处做法不同的地方，你学起来会快很多。

派发 Thread 的实际讲解节选（4115 字）：

    我们先说清楚这一轮的讲解顺序：**先讲“变量到底是个什么东西”，然后用同一个 `[1, 2]` 盒子一路推演出赋值、改内容、`+=` 和 `+` 的差别，最后才看严谨说法。** 函数传参和默认参数这两部分，等你在这一阶段的基础打牢之后再讲，不急着一次讲完。
    
    ---
    
    ## 一、先建一个画面：变量是贴在盒子上的便利贴
    
    不用记定义，先看这个场景：
    
    - `[1, 2]` 是一个**真实的盒子**，它在内存里有一块固定的位置，有自己的编号。
    - `a` 不是盒子，`a` 是一张**便利贴标签**。
    - `a = [1, 2]` 这个动作是：造一个盒子，然后把写着 `a` 的便利贴贴到它上面。
    
    关键就一句：**标签可以有很多张，盒子只有一个。** 撕掉一张标签、再贴一张新标签，都不会让盒子变成两个。
    
    用代码看：
    
    ```python
    a = [1, 2]
    print(id(a))      # 比如 140234... 这是盒子编号，你机器上的数字会不同
    
    b = a             # 注意：没有造新盒子，只是又贴了一张标签 b
    print(id(b))      # 和 id(a) 一模一样
    ```
    
    `id()` 就是盒子的编号。两个名字编号相同，说明它们指的是**同一个盒子**。
    
    ---
    
    ## 二、同一个盒子，四步推演
    
    我们全程只用这一个盒子 `[1, 2]`，看它怎么变：
    
    ```knowgap-widget
    {"type":"step_simulator","title":"标签 a、b 与同一个盒子的四步推演","steps":[{"label":"第1步：造盒子","detail":"执行 a = [1, 2]。内存中新建一个列表对象，把标签 a 贴上去。","state":[{"key":"盒子 [1, 2] 的编号","value":"id
    …（截断，原长 4115 字）

**【微件 JSON 校验 / 灰字预测原文】**

主对话未内联 `knowgap-widget`；派发 Thread 的讲解中实际嵌入了 `step_simulator`（节选见上）。

**【SSE 事件序列与实时延迟】**

- TTFT：`11422` ms；总耗时：`11870` ms。
- 序列：`start → tool_start → thread_dispatched → tool_end → delta×68 → done`

**【SQLite 数据库状态 Diff】**

```json
{
  "conversation_messages": {
    "before": 7,
    "after": 12,
    "delta": 5
  },
  "conversation_note_state": {
    "before": 0,
    "after": 1,
    "delta": 1
  },
  "conversations": {
    "before": 1,
    "after": 3,
    "delta": 2
  },
  "model_usage": {
    "before": 3,
    "after": 6,
    "delta": 3
  },
  "subjects": {
    "before": 0,
    "after": 1,
    "delta": 1
  },
  "thread_dispatches": {
    "before": 0,
    "after": 1,
    "delta": 1
  }
}
```

**【断言明细】**

```json
{
  "subject_status": 201,
  "http": 200,
  "anchors_empty": true,
  "probe_hint_present": true,
  "reply_asks_prior_language": true
}
```

### 第 5 轮 · 智能灰字追问补全与内存缓存实测

**结果：Fail**（PARTIAL）

> 两次调用均 10 ms 返回空字符串：`service.settings` 是 AISettings，而 `provider_endpoint()` 读取 `.llm_api_key` 触发 AttributeError，被 `except Exception` 静默吞掉；灰字功能实际不可用。

**【输入原文】**

```text
（接口操作，无对话输入）
```

**【灰字接口与用量关键结果】**

```json
{
  "note": "灰字预测不走 chat_messages，因此不产生 turn_context。",
  "usage_before": {
    "requests": 2,
    "reported_requests": 2,
    "input_tokens": 9480,
    "output_tokens": 657,
    "cached_tokens": 4864
  },
  "usage_after": {
    "requests": 2,
    "reported_requests": 2,
    "input_tokens": 9480,
    "output_tokens": 657,
    "cached_tokens": 4864
  }
}
```

**【AI 真实回复原文节选】**

灰字预测两次均返回空字符串（原因见问题清单 P0-2），无 150 字以上原文可摘录。

**【微件 JSON 校验 / 灰字预测原文】**

```json
{
  "suggestion": "",
  "message_id": "cmsg-ce03b7979cc74c229863dca7f4c92144",
  "length": 0,
  "cold_elapsed_ms": 10,
  "warm_elapsed_ms": 10,
  "same_as_warm": true
}
```

**【SSE 事件序列与实时延迟】**

- 冷调用 `10` ms；热调用 `10` ms；均返回空字符串。

**【SQLite 数据库状态 Diff】**

```json
{}
```

**【断言明细】**

```json
{
  "http": 200,
  "non_empty": false,
  "length_20_65": false,
  "cache_faster": true,
  "same_suggestion": true,
  "usage_unchanged": true,
  "first_person": false
}
```

### 第 6 轮 · 口头自述旧知 → 自动识别并触发对比迁移（场景 B）

**结果：Fail**（PARTIAL）

> AI 自行识别旧知并调用 memory 成功写入“先验技能：熟练 C 语言/C++…”；但确定性正则 `_REPORTED_PRIOR_RE` 未命中“我大一熟练学过”，因此 turn_context 没有 reported_prior_knowledge 与对比迁移提示。

**【输入原文】**

```text
我大一熟练学过 C 语言和 C++，对指针 int*、引用 int& 和栈/堆内存分配很熟，但没写过 Python。请按我的基础带我学。
```

**【`turn_context` 关键字段真实 JSON 节选】**

```json
{
  "latest_user_message": "我大一熟练学过 C 语言和 C++，对指针 int*、引用 int& 和栈/堆内存分配很熟，但没写过 Python。请按我的基础带我学。",
  "prior_knowledge_anchors": [],
  "reported_prior_knowledge": null,
  "transfer_learning_hint": "【迁移学习先验探针】当前尚不清楚用户的先验技能锚点。请在回应的同时，主动用 1 句话询问用户之前是否学过相近的语言或前置课程（例如学 Python 问是否会 C/C++），以便后续用对比迁移法教学；若用户告知已掌握某技能，请调用 `memory` 工具以 `先验技能：xxx` 格式记入 USER。",
  "recommended_widget": null
}
```

**【AI 真实回复原文节选】**

    明白了，我已把你的 C/C++ 基础（指针、引用、栈/堆内存）作为对比基准补充给正在执行的 Thread。接下来会以「C/C++ 机制 → Python 机制 → 容易从 C/C++ 带过来的错误直觉」这样的组织结构来讲解。
    
    一点提醒：C++ 的 `int&` 和 Python 的「引用」两个词不一样，二者最关键的区别，恰好是你最容易误解的地方，Thread 里会先在对比表中说明。

同一教学 Thread 在收到旧知后追加的讲解节选（4549 字）：

    有 C/C++ 底子，我们就不绕弯：**你的旧模型能解释 Python 的大部分行为，只有三个位置会“翻车”。** 本轮先给你一张全局对比图，然后只深入第一个主题（名字、指针、引用、内存位置），函数传参和可变默认参数留到后面两轮——因为那两个坑的根源都在今天讲的内容里。
    
    ---
    
    ## 一、先看全局图（三列分别是旧知、新知、易错点）
    
    ```knowgap-widget
    {"type":"comparison_matrix","title":"C/C++ 旧知 vs Python 新知 vs 跨语言负迁移","columns":["旧知机制（C/C++）","新知机制（Python）","跨领域负迁移易错点"],"rows":[{"dimension":"变量是什么","values":["具名内存槽，类型随声明绑定在变量上，作用域内地址固定","名字（name）在名字空间里，只存“指向某个堆对象”的引用；名字本身无类型","以为 `int a` 那样必须先声明类型；看到 `a = 1; a = \"s\"` 觉得是类型转换"]},{"dimension":"类型归属","values":["类型属于变量/表达式，编译器期决定","类型属于对象，运行时挂在对象上（`type(x)`）","以为 `def f(x: int)` 会像 C 一样强约束实参"]},{"dimension":"指针/引用的等价物","values":["`int* p` 可解引用改目标、可 ++、可为 NULL；`int& r` 是别名，必须初始化、不可重绑定","名字≈「const 指针 + 永远自
    …（截断，原长 4549 字）

**【微件 JSON 校验 / 灰字预测原文】**

本轮不涉及微件或灰字预测。

**【SSE 事件序列与实时延迟】**

- TTFT：`12516` ms；总耗时：`13025` ms。
- 序列：`start → tool_start → tool_end → tool_start → thread_dispatched → tool_end → delta×101 → done`

**【SQLite 数据库状态 Diff】**

```json
{
  "conversation_messages": {
    "before": 12,
    "after": 16,
    "delta": 4
  },
  "model_usage": {
    "before": 6,
    "after": 9,
    "delta": 3
  },
  "thread_dispatches": {
    "before": 1,
    "after": 2,
    "delta": 1
  }
}
```

```text
新增：
- 先验技能：熟练 C 语言/C++（指针 int*、引用 int&、栈/堆内存分配），但没写过 Python
```

**【断言明细】**

```json
{
  "http": 200,
  "reported_captured": false,
  "transfer_hint": false,
  "memory_tool_called": true,
  "user_note_changed": true,
  "prior_skill_in_note": true
}
```

### 第 7 轮 · Thread 执行层 C++ → Python 对比迁移 + comparison_matrix 微件

**结果：Pass**（PASS）

> comparison_matrix JSON 合法，列为 C++ 旧知机制 / Python 新机制 / 负迁移易错点，共 7 行；另含 step_simulator 与 micro_quiz。TTFT 39.5 s，输出 9671 tokens。

**【输入原文】**

```text
请结合我的 C++ 指针与引用基础，深入对比讲清楚 Python 的名字绑定（Name Binding）和可变对象传参，顺便用对比表格把两者的核心差异列出来。
```

**【`turn_context` 关键字段真实 JSON 节选】**

```json
{
  "latest_user_message": "请结合我的 C++ 指针与引用基础，深入对比讲清楚 Python 的名字绑定（Name Binding）和可变对象传参，顺便用对比表格把两者的核心差异列出来。",
  "active_skill": "【当前挂载 Skill：deep_explain（深度原理精讲）】\n按以下工作流开展本次原理精讲，并结合 turn_context.teaching_preferences 与 USER 画像动态调整：\n1. 开场直奔主线：先用一句话交代讲解脉络（例如：“我先从为什么需要 X 讲起，再通过同一个具体例子逐个对比。”），不要客套寒暄。\n2. 步骤可视化：在展开正文前，先调用一次 `plan_steps` 工具列出 3 个清晰步骤（例如：① 设计贯穿全文的具体小例子 `[completed]`、② 构建交互微件逐步对比核心机制 `[in_progress]`、③ 提炼一句话本质与自测切口 `[pending]`）。\n3. 贯穿全文的最小例子 + 强制内联交互微件：构造 1 个极简、具体的例子，后续所有概念对比都在这**同一个例子**上演绎；**本轮必须在正文中嵌入至少 1 个 `knowgap-widget` 交互微件**（优先按 …（截断，原长 2240 字）",
  "recommended_widget": "comparison_matrix（对比旧知机制、新知机制与跨领域负迁移易错点）",
  "prior_knowledge_anchors": [
    "熟练 C 语言/C++（指针 int*、引用 int&、栈/堆内存分配），但没写过 Python"
  ],
  "reported_prior_knowledge": null,
  "transfer_learning_hint": "【对比迁移学习】结合 prior_knowledge_anchors 或用户本轮明确自述的旧知，以相关的已知技能作为锚点映射新知识，优先使用 comparison_matrix 微件对比「旧知机制 vs 新知机制 vs 跨领域负迁移易错点」，明确类比的适用范围与失效边界。用户本轮明确告知已掌握某技能时，调用 memory 工具以 `先验技能：xxx` 格式记入 USER；仅为用户自述，不是经验证的掌握结论，不要从提问、假设、否定或助手的例子推断用户会某技能，不要重复询问已有锚点；待确认或失败时不得声称已保存。"
}
```

**【AI 真实回复原文节选】**

    思路是：**先拿一个 4 行的最小例子，在 C++ 和 Python 里分别“走一遍内存”**，然后在这个例子上做对比表，最后收束到两句话。之所以这样安排，是因为你已有的 C++ 直觉（变量=盒子、`&`=取地址、`T&`=别名）在 Python 里有一半能用、一半会误导你。
    
    ---
    
    ## 一、同一个例子的两次推演
    
    先看两边代码，注意它们**不是对应的**，这正是重点：
    
    ```cpp
    // C++：变量是盒子，引用是别名，指针是地址值
    int x = 5;        // x 是栈上一块内存，&x 有效
    int& r = x;       // r 是 x 的别名，必须初始化、绑定后不能换
    int* p = &x;      // p 里存 x 的地址，p 自己可以改指向
    r = 7;            // 透过别名改 x 的内容 → x == 7
    p = nullptr;      // 只改 p 自己，x 不受影响
    ```
    
    ```python
    a = [1, 2]     # 堆上建一个 list 对象，名字 a 绑定它
    b = a          # b 绑定同一个对象，没有拷贝元素
    b.append(3)    # 顺着 b 找到对象，改对象本身
    b = [9]        # 新建对象，b 改绑到它；a 的绑定一点没动
    ```
    
    下面的推演器把 Python 这一侧的内存变化拆开来看：
    
    ```knowgap-widget
    {"type":"step_simulator","title":"a = [1,2]; b = a; b.append(3); b = [9] 的内存推演","steps":[{"label":"① a = [1, 2]","detail":"在堆上创建一个 list 对象 [1, 2]，然后在命名空间里记一条 a →
    …（截断，原长 5952 字）

**【微件 JSON 校验 / 灰字预测原文】**

- `step_simulator`：JSON 合法
```json
{
  "type": "step_simulator",
  "title": "a = [1,2]; b = a; b.append(3); b = [9] 的内存推演",
  "steps": [
    {
      "label": "① a = [1, 2]",
      "detail": "在堆上创建一个 list 对象 [1, 2]，然后在命名空间里记一条 a → 那个对象。名字本身不装数据。",
      "state": [
        {
          "key": "a",
          "value": "→ [1, 2]  @0x1A2B",
          "highlight": true
        },
        {
          "key": "b",
          "value": "（未定义）"
        }
      ]
    },
    {
      "label": "② b = a",
      "detail": "把 a 当前指向的对象交给 b。两个名字指向同一个对象，一个元素都没复制。",
      "state": [
        {
          "key": "a",
          "value": "→ [1, 2]  @0x1A2B",
          "highlight": false
        },
        {
          "key": "b",
          "value": "→ [1, 2]  @0x1A2B（同一对象）",
          "highlight": true
        }
      ]
    },
    {
      "label": "③ b.append(3)",
      "detail": "顺着 b 里的指针找到对象，在对象内部追加元素。对象变了，所以通过 a 看也是 [1, 2, 3]。",
      "state": [
        {
          "key": "a",
          "value": "→ [1, 2, 3]  @0x1A2B",
          "highlight": true
        },
        {
          "key": "b",
          "value": "→ [1, 2, 3]  @0x1A2B（同一对象）",
          "highlight": true
        }
      ]
    },
    {
      "label": "④ b = [9]",
      "detail": "新建一个对象 [9]，把名字 b 改绑到它。关键：这是改「名字」，不是改「对象」。a 仍然绑在旧对象上。",
      "state": [
        {
          "key": "a",
          "value": "→ [1, 2, 3]  @0x1A2B",
          "highlight": false
        },
        {
          "key": "b",
          "value": "→ [9]  @0x3C4D",
          "highlight": true
        }
      ]
    }
  ]
}
```
- `comparison_matrix`：JSON 合法
```json
{
  "type": "comparison_matrix",
  "title": "C++ 旧知 vs Python 新机制 vs 负迁移易错点",
  "columns": [
    "C++ 旧知机制",
    "Python 新机制",
    "负迁移易错点"
  ],
  "rows": [
    {
      "dimension": "变量/名字是什么",
      "values": [
        "变量是有地址的存储槽，对象就在槽里（栈或堆）；&x 一定有效",
        "名字是命名空间字典里的键，值是指向堆上对象的指针；名字自己没有地址、没有类型",
        "想写 &a 或 int* p = &a 会直接落空；id(a) 是「对象」的地址，不是名字的地址"
      ],
      "takeaway": "盒子 → 标签，这一步没转过来，后面全错"
    },
    {
      "dimension": "= 做了什么",
      "values": [
        "调用赋值运算符，把右值写进左值那块存储，vector 会拷贝/移动元素",
        "只把名字重新绑定到另一个对象，永不拷贝、永不修改已有对象",
        "把 b = a 当深拷贝（以为改 b 不影响 a）；又把 b = [9] 当赋值（以为会影响 a）——两个方向都错"
      ],
      "takeaway": "赋值不产生数据流，只产生引用指向的变化"
    },
    {
      "dimension": "「引用」这个词的含义",
      "values": [
        "T& 是别名：必须初始化、不能改绑；r = 7 改的是被引用对象的内容",
        "没有别名语义；名字随时可改绑，行为上更像一个自动解引用的 T*（但没有指针算术）",
        "把 Python 名字当 int&：以为函数里 v = ... 会透传给调用方，实际只换了局部标签"
      ],
      "takeaway": "C++ 引用的「不能改绑」是 Python 名字没有的约束"
    },
    {
      "dimension": "函数传参",
      "values": [
        "T v 拷贝一份；T& v 绑定实参；T* p 拷贝指针值",
        "一律传「对象指针的副本」（call by sharing），形参是新名字，绑定同一个对象",
        "说「Python 传引用」→ 以为 v = ... 能换实参；说「传值」→ 以为 v.append() 不影响实参。两种说法各对一半"
      ],
      "takeaway": "传的是对象引用，不是对象，也不是变量槽位"
    },
    {
      "dimension": "改对象 vs 换对象",
      "values": [
        "引用形参上 v = other 改的是对象内容，调用方可见（std::vector 就是这么被换掉的）",
        "v = other 只改局部名字；要改内容得用 v[:] = other、v.clear()+extend()",
        "def init(v): v = [] 完全无效，最高频 bug；同理 v = sorted(v) 也不会影响调用方"
      ],
      "takeaway": "Python 里「换对象」和「改对象」是两条完全不同的语法路径"
    },
    {
      "dimension": "默认参数",
      "values": [
        "默认实参每次调用重新求值：void f(vector<int> v = {}) 每次都是新的空 vector",
        "默认值在 def 执行时求值一次，存进 f.__defaults__，所有调用共享同一个对象",
        "def f(x, acc=[]) 会跨调用累积元素；C++ 的经验在这里彻底失效"
      ],
      "takeaway": "默认值属于函数对象，不属于某次调用"
    },
    {
      "dimension": "对象身份与比较",
      "values": [
        "&a == &b 判断是不是同一对象；*a == *b 判断值相等",
        "a is b 判身份（同一对象），a == b 判值；相等不代表同一",
        "用 is 比较小整数和字符串，结果依赖小整数缓存（-5~256）和字符串驻留，不可靠"
      ],
      "takeaway": "is 对应指针相等，== 对应 operator=="
    }
  ]
}
```
- `micro_quiz`：JSON 合法
```json
{
  "type": "micro_quiz",
  "question": "xs = [1, 2]；def g(v): v += [3]；执行 g(xs) 后 print(xs) 输出什么？",
  "options": [
    "[1, 2]",
    "[1, 2, 3]",
    "报错 UnboundLocalError"
  ],
  "answerIndex": 1,
  "explanation": "list 实现了 __iadd__，v += [3] 是对共享对象的就地 extend，形参和实参指的是同一个对象，所以调用方可见。"
}
```

**【SSE 事件序列与实时延迟】**

- TTFT：`39542` ms；总耗时：`51127` ms。
- 序列：`start → tool_start → tool_end → tool_start → tool_end → delta×2972 → done`

**【SQLite 数据库状态 Diff】**

```json
{
  "conversation_messages": {
    "before": 16,
    "after": 20,
    "delta": 4
  },
  "conversation_note_state": {
    "before": 1,
    "after": 3,
    "delta": 2
  },
  "conversations": {
    "before": 3,
    "after": 4,
    "delta": 1
  },
  "model_usage": {
    "before": 9,
    "after": 18,
    "delta": 9
  }
}
```

**【断言明细】**

```json
{
  "thread_status": 201,
  "http": 200,
  "active_skill_deep_explain": true,
  "widget_recommended_comparison": true,
  "anchors_contain_cpp": true,
  "widget_json_valid": true,
  "matrix_rows": 7,
  "columns": [
    "C++ 旧知机制",
    "Python 新机制",
    "负迁移易错点"
  ]
}
```

### 第 8 轮 · 跨语言负迁移防坑拦截与 micro_quiz 实测

**结果：Pass**（PASS）

> 准确区分 C++ 调用点求值与 Python def 执行期求值；micro_quiz 四要素齐全（answerIndex=1）。

**【输入原文】**

```text
在 C++ 里函数默认参数如果是常量表达式很安全，那在 Python 里写 def append_item(x, target=[]): 有什么不一样？请专门针对我们 C++ 老手容易踩的这个负迁移坑出一道随堂微测题考考我。
```

**【`turn_context` 关键字段真实 JSON 节选】**

```json
{
  "active_skill": "【当前挂载 Skill：socratic_practice（启发式带练与错因诊断）】\n按以下工作流开展本次练习或答疑，并结合 turn_context.teaching_preferences 与 USER 画像动态调整：\n1. 若存在 active_exercise 且用户在作答或要提示，先调用 `exercise_reference` 获取经校验的标准过程与判据。\n2. 记忆自适应与互动微件：\n   - 当需要出随堂小题检验用户理解时，优先嵌入 `knowgap-widget` 的 `micro_quiz` 互动测验卡；\n   - 默认或用户偏好“自己想/给提示”时，先确认用户回答中正确的部分，再针对卡点给出**最小步进提示**和 1 个具体可回答的追问，不一次性泄底完整答案。\n3. 本轮结束前调用 `report_progress` 回报当前练习进展（等待用户继续作答时设 `needs_user=true`）。\n\n【先验锚…（截断，原长 1820 字）",
  "recommended_widget": "micro_quiz（建议在回复中嵌入 ```knowgap-widget 的 micro_quiz 随堂微测卡）",
  "prior_knowledge_anchors": [
    "熟练 C 语言/C++（指针 int*、引用 int&、栈/堆内存分配），但没写过 Python"
  ]
}
```

**【AI 真实回复原文节选】**

    你这个问法正好碰到了关键差别：**在 C++ 里，“每次都安全”是因为默认实参在调用点求值，然后拷贝进形参；而 Python 默认值在 `def` 那一刻求值一次，之后所有调用共享同一个对象。** 两者可以用一个最小对照说明：
    
    ```cpp
    // C++：默认实参在【调用点】替换，随后按值 拷贝进形参 v
    void f(std::vector<int> v = {}) { v.push_back(1); }
    f();  // 临时对象 → 拷贝进 v → 改副本 → 临时对象没人看见
    f();  // 又是全新的空 vector
    // 即使是 void f(std::vector<int> v = make())，make() 也是每次调用各执行一次
    ```
    
    ```python
    # Python：[] 在【def 执行时】求值一次，存进 append_item.__defaults__
    def append_item(x, target=[]):
        target.append(x)
        return target
    
    append_item.__defaults__        # ([],)  —— 这个 list 是函数对象的一部分
    ```
    
    差别不在“可变还是不可变”，而在这三件事：**求值时机的不同；默认值存放在哪里；每次调用时形参绑定的是同一个对象还是新对象。**
    
    ```knowgap-widget
    {"type":"comparison_matrix","title":"默认参数：C++ 旧知 vs Python 新机制 vs 负迁移易错点","columns":["C++ 旧知机制","Python 新机制","负迁移易错点"],"rows":[{"dimension":"求值时机","values":["默认实参在调用点被文本替换式求值，每次
    …（截断，原长 2410 字）

**【微件 JSON 校验 / 灰字预测原文】**

- JSON 解析失败：JSONDecodeError: Expecting ',' delimiter: line 1 column 886 (char 885)
- `micro_quiz`：JSON 合法
```json
{
  "type": "micro_quiz",
  "question": "上面这段代码会输出什么？",
  "options": [
    "[1] [2] False：每次调用都拿到新的空列表（C++ 直觉）",
    "[1, 2] [1, 2] True：两次调用绑定的是同一个 list，a 和 b 都指向它",
    "[1, 2] [1, 2] False：第二次调用虽然拿到了相同的值，但返回的是新建的列表"
  ],
  "answerIndex": 1,
  "explanation": "默认值 [] 在 def 执行时创建一次并存入 append_item.__defaults__，两次调用都绑定这同一个对象；第一次 append 改的是它，所以 a 看到的结果在第二次调用后被改变，a 和 b 是同一个对象。"
}
```

**【SSE 事件序列与实时延迟】**

- TTFT：`11662` ms；总耗时：`17368` ms。
- 序列：`start → delta×1139 → done`

**【SQLite 数据库状态 Diff】**

```json
{
  "conversation_messages": {
    "before": 20,
    "after": 23,
    "delta": 3
  },
  "model_usage": {
    "before": 18,
    "after": 22,
    "delta": 4
  }
}
```

**【断言明细】**

```json
{
  "http": 200,
  "negative_transfer_explained": true,
  "quiz_present": true,
  "quiz_question": true,
  "quiz_options": true,
  "quiz_answer": true,
  "quiz_explanation": true,
  "active_skill": "【当前挂载 Skill：socratic_practice（启发式带练与错因诊断",
  "recommended_widget": "micro_quiz（建议在回复中嵌入 ```knowgap-widget 的 micro_quiz 随堂微测卡）"
}
```

### 第 9 轮 · 多学科先验锚点叠加与跨空间复用（数学 + 编程）

**结果：Pass**（PASS）

> 带 `[Identity]` 前缀的锚点被 100% 解析；无先验探针，主对话直接做跨空间迁移。自动派发的 Thread 在停机时被取消，补测恢复锚点后成功生成 6851 字 + 3 个微件。

**【输入原文】**

```text
我想理解多元函数梯度下降的步长更新与矩阵向量化实现，请结合我已掌握的先验技能直接做迁移讲解。
```

**【`turn_context` 关键字段真实 JSON 节选】**

```json
{
  "prior_knowledge_anchors": [
    "C / C++、高等数学、线性代数"
  ],
  "transfer_learning_hint": "【对比迁移学习】结合 prior_knowledge_anchors 或用户本轮明确自述的旧知，以相关的已知技能作为锚点映射新知识，优先使用 comparison_matrix 微件对比「旧知机制 vs 新知机制 vs 跨领域负迁移易错点」，明确类比的适用范围与失效边界。用户本轮明确告知已掌握某技能时，调用 memory 工具以 `先验技能：xxx` 格式记入 USER；仅为用户自述，不是经验证的掌握结论，不要从提问、假设、否定或助手的例子推断用户会某技能，不要重复询问已有锚点；待确认或失败时不得声称已保存。",
  "recommended_widget": "comparison_matrix（对比旧知机制、新知机制与跨领域负迁移易错点）"
}
```

**【AI 真实回复原文节选】**

主对话回复（跨空间迁移说明）：

    好的，已为你开一个专门的学习 Thread 来讲解：它会从「蒙眼下山、每步迈多大」的直观画面切入，再用你已经掌握的高数偏导、线代矩阵乘向量和 C++ 循环作为类比，对照矩阵向量化写法；还会用对比矩阵标出类比容易失效的地方（例如学习率过大导致发散），结尾留一两道让你预测参数更新的小练习。

派发 Thread 补测实际讲解节选（6851 字，TTFT 28069 ms / 总耗时 50829 ms）：

    先给脉络：我先用一个「3 个样本、2 个参数」的最小例子走完一整步更新，再用你已经掌握的偏导、矩阵乘向量和 C 循环去对照它；然后做矩阵向量化，最后落到维度标注和两个版本的代码。
    
    ---
    
    ## 一、直观画面：蒙眼下山，每次只迈一小步
    
    你站在山坡上，眼睛被蒙住，只能用手杖探出脚下**最陡的上坡方向**。想下山，就朝反方向迈一步；步长 η 就是你敢迈多远。
    
    难点在于：这里不是 1 个参数，而是 n 个参数。n 维空间里的「一个点」就是向量 **w**；n 维空间里的「最陡上坡方向」就是梯度 ∇J(w)，也是一个 n 维向量。
    
    ### 贯穿例子（后面全部复用它）
    
    3 个样本，2 个参数，其中 x₀≡1 是偏置项：
    
    | 样本 | x₁ | x₂ | 真值 y |
    |---|---|---|---|
    | 1 | 1 | 1 | 3 |
    | 2 | 1 | 2 | 5 |
    | 3 | 1 | 3 | 7 |
    
    真实答案是 w=(1, 2)（你一眼能看出来：y = 1 + 2x）。但算法不知道，从 w=(0,0) 出发，η=0.1。
    
    ```knowgap-widget
    {"type":"step_simulator","title":"从 w=(0,0) 出发，手算一步梯度下降","steps":[{"label":"第 1 步：算预测 X·w","detail":"X(m×n)·w(n×1) 得到 3 个预测。w 全 0，所以三个预测全是 0。","state":[{"key":"w","value":"(0, 0)","highlight":true},{"key":"预测 Xw","value":"(0, 0, 0)"}]},{"label":"第 2 步：算残差 r = Xw − y","detail":"预测减真值。全为负，说明模型在系统性低估。","state":[{"key":"残差 r","value":"(−3, −5, −7)","highlight":true},{"key":"m","value":"3"}]},{"label":"第 3 步：
    …（截断，原长 6851 字）

**【微件 JSON 校验 / 灰字预测原文】**

补测 Thread 微件：`step_simulator`（合法）、`comparison_matrix`（合法）、`parameter_lab`（合法）

**【SSE 事件序列与实时延迟】**

- TTFT：`11462` ms；总耗时：`12063` ms。
- 序列：`start → tool_start → thread_dispatched → tool_end → delta×86 → done`
- 补测 Thread：首字 `28069` ms / 总耗时 `50829` ms。

**【SQLite 数据库状态 Diff】**

```json
{
  "conversation_messages": {
    "before": 23,
    "after": 28,
    "delta": 5
  },
  "conversation_note_state": {
    "before": 3,
    "after": 4,
    "delta": 1
  },
  "conversations": {
    "before": 4,
    "after": 6,
    "delta": 2
  },
  "model_usage": {
    "before": 22,
    "after": 25,
    "delta": 3
  },
  "subjects": {
    "before": 1,
    "after": 2,
    "delta": 1
  },
  "thread_dispatches": {
    "before": 2,
    "after": 3,
    "delta": 1
  }
}
```

```text
写入后 USER：
背景与目标：大二理工科学生，平时主要学习编程和数学，目标是准备算法竞赛和期末考
§
讲解偏好：讲新概念时不喜欢一上来堆公式定义，偏好先看直观现实例子或动画推演，再看严谨公式
§
互动偏好：贴出半截代码或思路时，希望先顺着其思路指出卡点，不要直接给出完整标准答案
§
[Identity] 常学领域：编程与数学（算法竞赛与期末复习并行）
§
[Preference] 讲解偏好：先看直观例子或动画推演，再看严谨公式，讨厌一上来堆公式定义
§
[Preference] 互动偏好：贴出半截代码时先顺着我的思路指出卡点，不要直接给完整标准答案
§
[Context] 阶段目标：准备算法竞赛和期末考
§
[Context] 背景约束：大二理工科在读，编程与数学是主线课程
§
[Activity] 近期动态：本周集中准备算法竞赛与期末复习
§
[Experience] 经验法则：先复现最小可运行例子再抽象公式，理解更稳
§
[Identity] 先验技能：C / C++、高等数学、线性代数
```

**【断言明细】**

```json
{
  "put_status": 200,
  "anchors_contain_prefix_items": true,
  "no_probe_hint": true,
  "transfer_hint": true,
  "reply_uses_math_or_cpp": true,
  "subject_status": 201
}
```

### 第 10 轮 · 先验技能边界防误判（假设句 / 疑问句不误记）

**结果：Pass**（PASS）

> 假设句/否定句未误记 Rust；最终 anchors=[]。灰字预测仍为空（同 R5 根因）。

**【输入原文】**

```text
如果我学过 Rust 的所有权机制的话，理解这个会不会更容易？但我其实完全没学过 Rust。
```

**【`turn_context` 关键字段真实 JSON 节选】**

```json
{
  "reported_prior_knowledge": null,
  "prior_knowledge_anchors": [],
  "transfer_learning_hint": null
}
```

**【AI 真实回复原文节选】**

    帮助很有限，基本不值得为此专门去学 Rust。
    
    原因：Rust 的所有权/借用解决的是「谁在什么时候拥有并释放一块内存」这类资源生命周期问题，靠的是编译期静态检查；梯度下降的核心是「沿负梯度方向按步长移动参数」的数值迭代，本质是微积分与线性代数，两者没有共同的抽象结构可迁移。
    
    唯一勉强能搭的桥是：更新 θ 时不能一边读旧 θ 一边原地覆盖（否则部分分量已被新值污染），这和「借用冲突」在表象上有点像——但它只是实现细节层面的巧合，硬套反而容易让你把「梯度方向」「学习率」这些关键概念理解歪。
    
    你已有的迁移资源已经很够了：高数的偏导/梯度给出方向，线代的矩阵乘向量给出向量化。这也是 Thread 里正在走的路子。

**【微件 JSON 校验 / 灰字预测原文】**

```json
{
  "suggestion": "",
  "message_id": "cmsg-e3a0b475b1ca4147bc8143d15e72eb4d",
  "length": 0,
  "cold_elapsed_ms": 9,
  "warm_elapsed_ms": null,
  "same_as_warm": null
}
```

**【SSE 事件序列与实时延迟】**

- TTFT：`5000` ms；总耗时：`6249` ms。
- 序列：`start → delta×180 → done`

**【SQLite 数据库状态 Diff】**

```json
{
  "conversation_messages": {
    "before": 28,
    "after": 30,
    "delta": 2
  },
  "model_usage": {
    "before": 25,
    "after": 27,
    "delta": 2
  }
}
```

```text
写入后 USER：
背景与目标：大二理工科学生，平时主要学习编程和数学，目标是准备算法竞赛和期末考
§
讲解偏好：讲新概念时不喜欢一上来堆公式定义，偏好先看直观现实例子或动画推演，再看严谨公式
§
互动偏好：贴出半截代码或思路时，希望先顺着其思路指出卡点，不要直接给出完整标准答案
§
[Identity] 常学领域：编程与数学（算法竞赛与期末复习并行）
§
[Preference] 讲解偏好：先看直观例子或动画推演，再看严谨公式，讨厌一上来堆公式定义
§
[Preference] 互动偏好：贴出半截代码时先顺着我的思路指出卡点，不要直接给完整标准答案
§
[Context] 阶段目标：准备算法竞赛和期末考
§
[Context] 背景约束：大二理工科在读，编程与数学是主线课程
§
[Activity] 近期动态：本周集中准备算法竞赛与期末复习
§
[Experience] 经验法则：先复现最小可运行例子再抽象公式，理解更稳
§
[Identity] 先验技能：C / C++、高等数学、线性代数
```

**【断言明细】**

```json
{
  "put_status": 200,
  "http": 200,
  "rust_not_reported": true,
  "rust_not_anchored": true,
  "suggestion_status": 200,
  "suggestion": ""
}
```

## 3. 发现的边缘问题与优化建议

### 3.1 P0：阻断功能或安全边界

#### P0-1 智能灰字追问补全实际不可用（R5 / R10）
- **实测**：R5 冷调用 10 ms、热调用 10 ms，均返回 `suggestion: ""`；R10 同样为空。两次调用 `/usage` 完全不变（2 requests / 9480 input / 657 output），说明没有发生模型请求。
- **根因**：`create_app()` 把 `AISettings` 实例传给 `ChatService`（`main.py` → `ChatService(..., ai_settings)`），而 `suggest_reply` 直接调用 `provider_endpoint(service.settings)` 并读取 `service.settings.llm_model`。`AISettings` 只有 `.current`，没有 `.llm_api_key/.llm_base_url/.llm_model`，因此立刻抛出 `AttributeError`。
- **证据**：定向复现 `provider_endpoint(AISettings)` → `AttributeError: 'AISettings' object has no attribute 'llm_api_key'`；`provider_endpoint(holder.current)` 正常返回 `deepseek-flash`。
- **放大问题的写法**：`except Exception: pass` 把配置/网络/解析错误全部吞掉，前端只能看到“没有建议”，无法区分“模型没想到”和“功能坏了”。
- **建议**：
  1. 在 `app/chat/router.py` 的 `suggest_reply` 中改用 `settings = service.settings.current if hasattr(service.settings, "current") else service.settings`，后续统一使用 `settings`。
  2. 至少记录 `logger.warning("suggest-reply failed", exc_info=True)`，并返回可区分的错误标记（如 `{"suggestion": "", "reason": "provider_error"}`）。
  3. 增加回归用例：给定一条已完成的 assistant 消息，断言 `suggestion` 非空、长度在 20–65 之间、且 `/usage` 不增加。

#### P0-2 缺少验证码即可完成邮箱注册（R1 + 补充复测）
- **实测**：主轮 `POST /api/auth/register {email, password}`（不带 `code`）返回 **201** 并签发 Token；补充复测同样返回 201。
- **根因**：`RegisterBody.code: str | None = None`，`register_local(..., code=body.code)` 只有在 `code is not None` 时才调用 `verify_email_code`。省略字段即跳过验证。
- **风险**：任意人可用任意未注册邮箱建号，验证码形同虚设；与“邮箱验证码认证闭环”的产品承诺冲突。
- **建议**：邮箱注册强制要求 `code`（缺失返回 422）；若要保留本地演示，显式增加 `demo=true` 或仅在 `delivery=demo` 的沙盒模式下允许省略，并在响应中标注。
- **验证用例**：不带 code → 422；错误 code → 400；正确 code → 201；重复邮箱 → 409。

#### P0-3 SMTP 发送失败后验证码流程不可完成（R1）
- **实测**：`POST /api/auth/send-code` 返回 **502**（“验证码邮件发送失败，请检查后端 SMTP 邮箱配置”），耗时 1920 ms；`email_verification_codes` 仍留下 1 行。
- **问题链**：`create_email_code()` 先落库验证码，再尝试 SMTP；发送失败抛 502，响应里没有 `demo_code`，用户既收不到邮件也拿不到演示码；该验证码行仍然有效，但无法被用户获知。
- **建议**：发送失败时删除该验证码行（或标记失效），并返回可重试的明确错误；本地/演示模式可在 SMTP 失败时回退返回 `demo_code`（需显式开关）。同时给 `send-code` 增加按邮箱/IP 的速率限制。
- **补充复测**：关闭 SMTP 后，`delivery=demo` 路径完整通过——正确码 201、错误码 400、验证码登录 200、密码登录 200、`/me` 200。

### 3.2 P1：核心体验与正确性

#### P1-1 无 Token 访问受保护接口会回落到 demo 学生（R1）
- **实测**：`GET /api/conversations` 不带 `Authorization` → **200**，返回 demo 学生的 0 条会话；伪造 Token → 401。
- **根因**：`AuthStore.student_from_request()` 在缺少 header 时直接 `return DEMO_STUDENT`。
- **风险**：本地演示方便，但与“多租户隔离”语义冲突；一旦部署到非 demo 环境，未登录请求会读写 demo 数据而不是被拒绝。
- **建议**：增加显式 `demo_mode` 开关；非 demo 模式下无 Token 一律 401；或仅对只读演示接口放行，并返回 `X-Demo-Student` 标记。

#### P1-2 确定性先验识别漏掉常见口述（R6）
- **实测**：输入“我**大一熟练**学过 C 语言和 C++……”时，`turn_context.reported_prior_knowledge = null`，`transfer_learning_hint` 仍是“先验探针”，而不是“对比迁移学习”。
- **根因**：`_REPORTED_PRIOR_RE` 结构为“我 + 可选时间词 + 学过/掌握/熟悉/会”，中间不允许“大一熟练”这类状语。AI 自身仍识别了旧知并调用 `memory` 成功写入（`先验技能：熟练 C 语言/C++…`），说明模型层能兜底，但确定性注入层没有触发。
- **副作用**：本轮已经回答了“会不会 C/C++”，但 `turn_context` 又给出探针提示，模型可能重复追问，违背“不要重复询问已有锚点”。
- **建议**：把状语纳入匹配（如 `我[^，。！？；]{0,8}(?:学过|掌握了?|熟悉|会)`），或改为“规则召回 + 模型判定”的双通道；为“我大一熟练学过”“我本科自学过”“工作中用过”补回归用例。
- **边界验证**：`我没学过 Rust`、`我以前没学过 C++` 不会命中（好事）；`如果按照老师说的，我以前学过 Haskell` 会命中（见 P1-3）。

#### P1-3 假设/否定过滤是“紧邻前缀”判断，存在假阳性（R10 通过，但边界仍脆）
- **实测**：R10 原句“如果我学过 Rust 的所有权机制的话……但我其实完全没学过 Rust”被双重过滤（前缀“如果” + 结尾“的话”），`reported_prior_knowledge = null`，结果正确。
- **静态反例**：`如果按照老师说的，我以前学过 Haskell` 会命中 `我以前学过 Haskell`，因为 `match.start()` 前的文本是“如果按照老师说的，”，不以“如果”结尾。
- **建议**：按分句/句法窗口检测假设标记（如果/假如/假设/要是/若），而不是只看紧邻前缀；同时对“没/未/不/从未”做否定前置判断；补充上述反例测试。

#### P1-4 teaching_preferences 重复膨胀（R3）
- **实测**：`teaching_preferences` 长度为 **4**：onboarding 写入的 2 条无标签偏好 + 本轮 `[Preference]` 写入的 2 条带标签偏好。五层分类本身正确（`non_preference_leaked = []`）。
- **影响**：每轮 prompt 重复携带相近偏好，增加 token、可能产生互相冲突的指令；UI 的“五层画像”也会显示重复条目。
- **建议**：写入前按“归一化标签 + 内容相似度”去重；同维度优先 `patch` 已有条目而不是 `add`；或在 `chat_messages` 组装 `teaching_preferences` 时按标签去重（保留最新）。

#### P1-5 先验锚点粒度与语义污染（R6 / R9）
- **实测 R6**：写入的条目是“先验技能：熟练 C 语言/C++（指针 int*、引用 int&、栈/堆内存分配），**但没写过 Python**”。R7 的 `prior_knowledge_anchors` 原样包含这整句，其中混入了“没写过 Python”的否定约束。
- **实测 R9**：写入“先验技能：C / C++、高等数学、线性代数”后，`prior_knowledge_anchors` 只有一个元素 `["C / C++、高等数学、线性代数"]`，不是三个独立锚点。
- **影响**：模型拿到的是一个长字符串，跨学科匹配与“哪个锚点适用”的判断变粗；否定信息与技能信息混在同一锚点，容易被误读为“会/不会 Python”。
- **建议**：写入时拆成多个条目（`先验技能：C/C++`、`先验技能：高等数学`、`先验技能：线性代数`），把“没写过 Python”放到 `背景约束：`；解析时按 `、/，/,` 二次拆分锚点。

#### P1-6 长首字延迟与高 token 成本（R7 / R9 Thread）
- **实测**：R7 TTFT **39,542 ms**、总耗时 **51,127 ms**、输出 **9,671 tokens**；R9 补测 Thread TTFT **28,069 ms**、总耗时 **50,829 ms**、输出约 6,851 字正文。
- **根因（代码事实）**：`ChatCompletionsChat.stream()` 只转发 `delta.content`，忽略 DeepSeek 的 `reasoning_content`；`deepseek-flash` 是推理型模型，思考阶段前端完全静默，首字延迟被放大。
- **建议**：把 reasoning 作为独立的 `thinking` 事件流式下发（前端显示“思考中”与已用时长），或至少每 1–2 秒发送 heartbeat；对 `deep_explain` 限制 `reasoning_effort`/`max_tokens`；前端在 3 秒无 delta 时展示骨架与“正在推理”提示。

#### P1-7 `recommended_widget` 会覆盖练习意图（代码事实）
- **位置**：`app/chat/agent.py` 第 256–261 行：只要前两轮出现先验锚点且角色不是 `main`，就把 `recommended_widget` 强制改成 `comparison_matrix`，即使 `recommend_widget()` 已经识别出 `micro_quiz`。
- **本轮表现**：R8 因为 `learning_topic` 未命中而没有进入该分支，`recommended_widget` 保持 `micro_quiz`；但用户若说“对比一下，再考我一道”，练习意图会被覆盖。
- **建议**：显式练习意图（考我/出题/测验）优先级高于迁移提示；或把推荐改成数组/合并文本，而不是单值覆盖。

#### P1-8 `suggest-reply` 的长度契约与缓存策略
- **契约不一致**：prompt 要求 20–65 字，路由却接受 6–120 字并缓存；修复 P0-1 后，可能出现 6 字的空洞建议被缓存。
- **缓存**：`_suggest_cache` 是无上限、无 TTL 的进程内 dict，长会话会持续增长；空结果不缓存，修复后每次失败都会重打模型。
- **建议**：校验 20–65 字（超出则重试或丢弃）；使用 `functools.lru_cache`/TTL 缓存；对空结果做短 TTL 负缓存；在 `usage` 中显式标注灰字预测是否计费。

### 3.3 P2：一致性、可观测性与测试契约

1. **`agent_state.onboarded` 未同步**：`onboarding_sessions.status = completed`、`confirmed_entries` 已写入，但 `agent_state.onboarded` 仍为 **0**。当前 `/api/onboarding` 读 `onboarding_sessions` 所以显示正确，但两套状态源存在漂移风险；建议 `complete_onboarding` 同步更新 `agent_state`。
2. **R3 的 DB Diff 为空是计数口径问题**：PUT 更新的是同一行 `agent_memory`，行数不变，所以 `db_diff = {}`；内容 Diff 已在报告中单列。建议后续用“内容哈希/行级前后值”而非仅计数。
3. **接口/表/字段命名与剧本不一致**（非产品缺陷，但测试脚本需对齐）：
   - 剧本 `/api/agent/notes` → 实际 `/api/agent-memory`（GET/PUT，body `{target, content}`）。
   - 剧本 `auth_users` → 实际 `users`。
   - 剧本 onboarding `stage 0→1→2→3` → 实际是字段名 `background → explanation → interaction → null(ready)`。
   - 剧本 micro_quiz `answer` → 实际前端契约是 `answerIndex`。
4. **验证码行的清理与限流**：发送失败会留下未消费的验证码行；建议失败即删、过期清理、按邮箱/IP 限流。
5. **派发 Thread 的生命周期展示**：R9 主对话已宣告“已开 Thread”，但 Thread 仍在 `working`；停机取消后消息被标记 `failed`（error=“服务重启，生成被中断”），同时 `checkpoint_available=true`。这不是本轮产品失败（补测已成功），但前端应明确显示“仍在生成/可恢复”，避免主对话的完成语气让用户误以为结果已就绪。
6. **遥测归属**：R4/R9 的主对话会 `dispatch_thread`，Thread 的首条用户消息与主对话输入相同，导致同一条 `latest_user_message` 出现两次 `chat_messages` 捕获。本报告按“最后一次匹配”取值，并在 R4/R9 单独标注 Thread 数据；后续建议在捕获中带上 `conversation_id`（本次未改业务源码，仅在运行时包装，无法直接取得该参数）。

### 3.4 正向结论（可复现）

- **Onboarding（R2）**：3 轮 `quote` 全部逐字命中用户原话；stage 严格推进 `background → explanation → interaction → ready`；`complete` 返回 `status=completed, onboarded=true`，USER 写入 3 条画像。
- **先验探针（R4）**：`prior_knowledge_anchors=[]` 时正确注入“【迁移学习先验探针】”，AI 主动询问“之前是否学过 C/C++、Java”，并派发 Thread 做直观讲解。
- **对比迁移（R7）**：`comparison_matrix` JSON 合法，列为“C++ 旧知机制 / Python 新机制 / 负迁移易错点”，共 7 行；同时输出 `step_simulator` 与 `micro_quiz`，全部通过 JSON 校验。
- **负迁移防坑（R8）**：AI 准确区分“C++ 默认实参在调用点求值并拷贝”与“Python 默认值在 `def` 执行时创建一次并被所有调用共享”；`micro_quiz` 四要素齐全，`answerIndex=1`。
- **多锚点跨空间（R9）**：`[Identity] 先验技能：C / C++、高等数学、线性代数` 被完整识别；无多余探针；补测 Thread 生成 6,851 字，含 `step_simulator`、`comparison_matrix`、`parameter_lab`。
- **边界防误判（R10）**：假设句 + 明确否定未把 Rust 记入先验技能，最终 `anchors=[]`。

### 3.5 建议的修复顺序与验收用例

| 优先级 | 位置 | 修复 | 验收 |
|---|---|---|---|
| P0 | `app/chat/router.py` suggest_reply | 使用 `service.settings.current`，记录异常 | 冷调用非空 20–65 字、热调用命中缓存、usage 不变 |
| P0 | `app/auth/router.py` register | 邮箱注册强制 code | 无 code→422；错码→400；正码→201 |
| P0 | `app/auth/router.py` send-code | 失败清理验证码或回退 demo | SMTP 失败不留下不可达验证码；demo 模式可完成注册 |
| P1 | `app/auth/store.py` student_from_request | 非 demo 模式无 Token→401 | 无 Token 访问 `/api/conversations`→401 |
| P1 | `app/chat/agent.py` `_REPORTED_PRIOR_RE` | 允许状语、分句级假设/否定判断 | “我大一熟练学过 C++”命中；“如果…我以前学过”“我没学过”不命中 |
| P1 | `app/chat/agent.py` teaching_preferences | 按标签去重、同维度 patch | 重复写入后仍只有 2 条偏好 |
| P1 | 先验锚点写入/解析 | 按 `、` 拆分、否定信息移到 Context | R9 得到 3 个独立锚点 |
| P1 | `app/agents/llm.py` streaming | 下发 reasoning/心跳、限制 effort | R7 类请求首字延迟显著下降且有思考反馈 |
| P2 | `app/chat/store.py` complete_onboarding | 同步 `agent_state.onboarded` | 两处状态一致 |

---

**测试收尾**：8001 端口进程已停止（脚本 `server.should_exit=True` 并 `join` 成功，补充复测同样停止）；隔离数据库与全部原始结果保存在 `C:\Users\mfgyy\AppData\Local\Temp\opencode\qa_node_1\`（`results.json`、`auth_demo.json`、`r9_thread2.json`、`knowgap.sqlite3`）。未修改任何业务源码，未触碰 8000/8002/8003/8004。


