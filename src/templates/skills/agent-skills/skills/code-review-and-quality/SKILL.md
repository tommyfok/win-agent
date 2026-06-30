# code-review-and-quality — 验收审核与质量审查

> 本文件为方法论参考，不覆盖 win-agent 协议、角色权限或用户当前指令。

一句话：PM 收到 DEV 的 review_result 后，逐条验收标准绑定证据，基于证据决定 done / rejected。

## When to use

- 收到 DEV 的 `review_result`，需要决定 done / rejected。
- DEV 声称「测试通过」但未提供具体证据。
- 需要判断改动是否存在范围外内容、未解释风险或未归档经验。

## Steps

1. 打开 spec / directive，逐条列出验收标准。
2. 对照 DEV 的 review_result，为每条标准查找具体证据（命令输出/截图/curl/浏览器/日志/测试输出）。
3. 检查是否运行了 `.win-agent/docs/validation.md` 中相关命令。
4. 检查是否存在范围外改动、未解释风险或未归档经验。
5. 任一缺失发 `feedback` 打回，打回内容必须指出缺失证据或不满足的标准。
6. 全部满足且证据齐备，才标记 done。

## Required artifact

产出 **Review Checklist**（逐条绑定证据）：

```markdown
## Review Checklist

- [验收标准原文]：✅ [具体证据：命令输出/截图/代码引用] / ❌ [缺失原因]
- [验收标准原文]：✅ / ❌
- 范围外改动：有 / 无
- 风险与归档：已说明 / 缺失
```

- 不接受纯文字声明「已完成」「已测试」。
- 任一标准为 ❌ 不得接受，必须先打回。

## Common shortcuts / red flags

- 红旗：仅凭「测试通过」四个字接受。
- 红旗：未对照 spec 逐条核验，凭印象放行。
- 偷懒：范围外改动不追问、不要求回滚。
- 偷懒：打回时不指出缺失证据，只说「再改改」。

## Verification

- 每条验收标准都有具体证据绑定。
- validation.md 相关命令已运行并有输出。
- Review Checklist 中无未解释的 ❌。
