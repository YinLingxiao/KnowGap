# 接口约定

> 待补充：前后端接口契约。

## 约定

- Base URL：`NEXT_PUBLIC_API_BASE_URL`
- 数据格式：`application/json`
- 鉴权：待定

## 接口列表

| 方法 | 路径 | 说明 | 状态 |
| --- | --- | --- | --- |
| GET | `/health` | 健康检查 | 待实现 |
| POST | `/api/diagnosis` | 发起知识盲区诊断 | 待实现 |

## 错误格式

```json
{
  "detail": "错误描述"
}
```
