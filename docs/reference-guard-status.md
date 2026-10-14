# Cursor 验收反馈修复记录 — 2026-10-14

## 问题与决策

Cursor 发现：学生对不可能的序列声称“合法”，模型返回 correct 且引用确实来自学生原文时，
原接口仍接受该判断。引用真实性与诊断正确性是两项不同校验。

现增加首次明确结论的参考结果否决：使用现有确定性栈模拟器，不再增加一个模型来复判。
在模型输出通过结构和引用校验后、事务写入前，保守识别首次回答中的句首结论。
若学生结论与模拟结果相反，但模型判 correct，则返回 502：

`模型判断与题目参考校验冲突，请重试；本次作答尚未保存。`

不自动改成错误诊断、不编造学习误区、不写入记忆，也不自动重试收费调用。

## 改动

- `backend/app/services/reference_guard.py`：保守结论识别及参考结果否决。
- `backend/app/services/teaching.py`：首次诊断写入前调用校验；后续局部提问不套用整题结论。
- `backend/checks/test_reference_guard.py`：两种结论方向、引用/条件/疑问/更正表述、回滚及对话边界回归。
- Cursor 的 `test_real_quote_with_wrong_assessment_is_not_regraded` 更名为
  `test_real_quote_with_wrong_assessment_is_rejected_by_reference`，仅同步其预期到 502 和无写入。
  该文件其余用例保持原样，仍留给 Cursor 提交。
- 原 `test_health.py` 改为临时库并显式启动/停止应用生命周期，不连接默认开发数据库。
  原测试未使用 TestClient 上下文，本轮观察到 `backend/data` 并不存在；不能据此声称曾污染开发库。
- `docs/api.md` 增补校验规则和适用范围，不变更请求/响应字段。

## 实际验证

在 `backend/` 执行：

```powershell
.venv/Scripts/python.exe -m pytest checks tests -q --tb=short
```

结果：**67 passed, 1 warning in 1.55s**。
包含 GPT 核心回归、新增参考校验回归和 Cursor 的独立验收用例。
警告仍为 Starlette 对 httpx TestClient 集成的弃用提示。
所有模型响应均来自测试替身或 HTTP MockTransport，数据库使用临时目录。

## 边界

- 仅校验已识别的首次明确结论，不是完整自然语言判卷，也不是通用抗提示注入保障。
- 引用、条件句、疑问句、相互矛盾或未覆盖的表达不自动重判，仍依赖模型。
- 最终结论一致不证明推理正确；正确结论配错误理由仍允许模型判 incorrect。
- 后续对话的局部理解、真实模型会否循环追问及是否利用记忆改善教学仍待人工评估。
- `docs/evaluation/2026-10-14-acceptance.md` 保留 Cursor 当时的历史观察；该漏洞的最新状态以本记录为准。
