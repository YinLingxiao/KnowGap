# AnySearch 联网搜索

侧栏“联网搜索”调用真实 AnySearch REST API，展示网页标题、摘要和原始链接。
“导师联网参考”开关默认关闭；开启后，首次作答与后续教学先检索相关网页，
再将搜索结果送入模型上下文。导师引用会展示可展开的来源，并随会话保存和恢复。
打开搜索窗口保留答案草稿，Esc 关闭窗口。手动搜索不需要 DeepSeek Key。

## 配置

后端 `.env` 可选设置：

```dotenv
ANYSEARCH_API_KEY=
ANYSEARCH_TIMEOUT_SECONDS=20
```

留空 Key 使用 AnySearch 匿名配额；填写 Key 后使用 Bearer 认证。
AnySearch Key 与模型 Key 独立，均不进入前端公开环境变量。
匿名额度耗尽或限流会显示明确错误，不自动注册账户或回显供应商返回的凭据。

## 接口

`GET /api/search?q=搜索关键词&limit=5`：q 为 1–600 个字符，limit 为 1–10。
返回 provider、query、results、request_id；每条结果有 id、label、title、url、snippet。
后端调用 `POST https://api.anysearch.com/v1/search`，使用 JSON 格式和 zh-CN 语言偏好。
联网搜题在本机抓取失败后调用 `POST /v1/extract` 取正文。匿名额度按天按 IP 计算，建议在 `backend/.env` 配置 `ANYSEARCH_API_KEY`。
响应去重，链接仅保留有效 HTTP/HTTPS 地址，禁止携带 URL 用户名/密码。
不抓取任意用户提供 URL，不执行搜索结果中的指令。

教学请求增加默认 false 的 `web_search`。响应与恢复的消息增加默认空数组 `web_sources`。
模型可在正文标记 `[网页1]`，在 `web_source_ids` 返回本轮结果的 ID；无效 ID 或未绑定标注返回 502。
来源仍是待判断参考，不覆盖可信栈模拟或学生当前作答证据。
网络来源校验防止编造 ID，不等于自动证明来源权威性或解释正确性。

关闭开关时不调用 AnySearch。开启时搜索失败会返回可读错误，不保存失败轮次。
搜索超时默认 20 秒；联网教学前端请求等待上限调整为 100 秒。
资料上传、课件检索与 OCR 不属于此功能。

## 验证

- 后端 102 项回归、前端接口 12 项检查通过，lint/类型检查/生产构建通过。
- 实际 HTTP smoke 与已有教学/记忆/重启恢复流程通过。
- AnySearch 匿名真实搜索成功，返回 cppreference、W3Schools 等来源，约 9.42 秒。
- AnySearch → deepseek-flash → SQLite 真实教学成功，约 22.61 秒；正确诊断错误结论，引用 LeetCode 栈序列资料并保存来源。
- 浏览器验证手动搜索、来源链接、空/错误结果、Esc、草稿保留、开关、引用恢复和手机宽度。

真实测试使用临时数据库与合成学生回答。Key 仅进入测试进程内存。
上述调用为小样本，不代表搜索覆盖率或教学总体准确率。

官方接口说明：https://anysearch.com/docs/api-endpoints/v1-search
