# 系统架构

> 待补充：KnowGap 的整体架构设计。

## 概览

- **前端**：Next.js，负责交互与呈现。
- **后端**：FastAPI，负责 API、AI 诊断与引导、长期记忆治理。
- **文档 / 演示**：`docs/`、`demo/`。

## 模块划分

| 模块 | 路径 | 职责 |
| --- | --- | --- |
| API 路由 | `backend/app/api` | HTTP 接口层 |
| AI 诊断与引导 | `backend/app/agents` | Agent 编排、诊断与引导逻辑 |
| 长期记忆治理 | `backend/app/memory` | 用户知识盲区的长期记忆存储与治理 |
| 数据结构 | `backend/app/models` | Pydantic / ORM 数据模型 |
| 业务逻辑 | `backend/app/services` | 领域服务 |

## 待办

- [ ] 补充数据流图
- [ ] 补充部署拓扑
