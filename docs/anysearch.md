# AnySearch 联网搜索

AnySearch 提供联网搜索的网页结果（标题、摘要和原始链接）。设置页的“搜索 Key”卡片保存并测试 AnySearch Key；
第一版的侧栏搜索窗口、“导师联网参考”开关和 `GET /api/search` 已随诊断工作台删除。AnySearch Key 不需要模型 Key。

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

`GET /api/search` 已随第一版诊断工作台删除。现役入口：`GET/PUT /api/search/config` 保存 Key，`POST /api/search/test` 测试 Key（见设置页的搜索 Key 卡片）。
后端调用 `POST https://api.anysearch.com/v1/search`，使用 JSON 格式和 zh-CN 语言偏好（`services/anysearch.py` 的 `AnySearchClient`）。
联网搜题在本机抓取失败后调用 `POST /v1/extract` 取正文。匿名额度按天按 IP 计算，建议在 `backend/.env` 配置 `ANYSEARCH_API_KEY`。
响应去重，链接仅保留有效 HTTP/HTTPS 地址，禁止携带 URL 用户名/密码。
不抓取任意用户提供 URL，不执行搜索结果中的指令。搜索超时默认 20 秒。
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
