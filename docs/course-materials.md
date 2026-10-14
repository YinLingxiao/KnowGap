# 课程资料检索

侧栏新增“课程资料”。在真实后端模式下可上传资料、搜索原文、删除资料。
切换资料页会保留学习会话与未提交的答案；导师引用可在对话下方展开，显示原文和位置。

## 接口

| 方法与路径 | 功能 |
| --- | --- |
| GET `/api/materials` | 已上传的资料列表 |
| POST `/api/materials` | 上传单个文件，multipart 字段名为 `file` |
| GET `/api/materials/search?q=栈&limit=5` | 搜索原文，limit 为 1–10 |
| DELETE `/api/materials/{document_id}` | 删除资料及检索索引，成功返回 204 |

身份沿用 `demo-student-001`；接口不是公共多用户服务。
资料列表返回 id、title、kind、page_count、chunk_count、created_at。
结果返回 id、document_id、title、label、page、start_line、end_line、excerpt。
PDF 的 page 从 1 开始；TXT/Markdown 使用从 1 开始的原始行号。

## 上传规则

- 支持含可复制文字的 PDF、UTF-8 TXT、Markdown。
- 单份最多 5 MB、100 页、200,000 字符；最多 30 份资料。
- 暂不支持扫描 PDF OCR、加密 PDF、DOCX/PPTX。
- 仅保存提取的文字与元数据，不保存原始文件；同名重复上传会生成独立资料。
- 删除后停止检索。历史对话的引用快照仍保留，前端删除确认中有说明。

## 检索与教学

采用 SQLite FTS5 关键词检索。中文建立字与双字词索引，英文采用词项索引；不额外调用模型或嵌入 API。
片段上限 1000 字符，PDF 按页分片，文本保留行号。
当前题库只有栈题，教学自动使用“栈、LIFO、后进先出”检索，最多补充三个片段。
后续扩展题库时需扩展知识点检索词。关键词检索不等于语义检索，换词或跨表达可能漏召回。

模型 JSON 增加可选 `citation_ids`，导师回复中使用 `[资料1]` 一类标注。
引用 ID 必须来自本轮提供的资料，正文的资料标注必须绑定有效 ID；否则返回 502 且不保存本轮。
资料是补充上下文，不能覆盖可信栈模拟参考、诊断规则或学生原文证据。
引用校验能防止编造 ID，不能自动证明模型解释与原文在语义上完全一致。

`TeachingResponse` 和 `SessionMessage` 新增默认空列表 `sources`。
引用以快照与教学消息在同一事务保存，恢复会话后可继续展开；删除与生成竞争时返回 409。
已有消息表与教学请求字段保持兼容，新增独立资料和引用表。
前端通过 multipart 上传，浏览器自动设置 boundary；Mock 模式显示说明，不混入真实资料。

## 启动与验证

先在 backend 更新依赖：`python -m pip install -r requirements-dev.txt`。
前端沿用 API 模式配置：`NEXT_PUBLIC_DATA_SOURCE=api`，`NEXT_PUBLIC_API_BASE_URL=http://localhost:8000`。

```bash
cd backend
python -m pytest checks tests -q
python checks/smoke_http.py
python checks/integration_http.py
cd ../frontend
npm run test:api
npm run lint
npm run build
```

实现与验证记录见 `docs/evaluation/2026-10-14-course-materials.md`。
