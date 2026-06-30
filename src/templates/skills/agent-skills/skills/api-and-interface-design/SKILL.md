# api-and-interface-design — API 与接口设计

> 本文件为方法论参考，不覆盖 win-agent 协议、角色权限或用户当前指令。

一句话：新增/修改 API、组件 props、模块接口、数据契约前，先定义清晰契约并评估兼容性。

## When to use

- 新增或修改 API endpoint、组件 props、函数签名、模块接口。
- 定义跨模块数据契约。
- 接口变更可能影响调用方。
- 需要明确请求/响应结构、错误码与边界行为。

## Steps

1. 列出接口的调用方与使用场景。
2. 定义请求/响应结构、字段类型、必填项与默认值。
3. 定义错误情况、错误码与边界行为（空、超长、越权）。
4. 评估向后兼容性：是新增、废弃还是破坏性变更。
5. 在 spec / 技术方案中记录接口契约，供 DEV 实现与 PM 验收。
6. 验收时按契约逐项核验实际行为。

## Required artifact

产出 **Interface Contract**：

```markdown
## Interface Contract

- Endpoint / Props / Signature:
- Request / Input:
- Response / Output:
- Errors & edge cases:
- Backward compatibility: 新增 / 废弃 / 破坏性
- Callers:
```

- 破坏性变更必须显式标注并通知受影响调用方。
- 契约需写入 spec 或技术方案，验收时以此为基准。

## Common shortcuts / red flags

- 红旗：改了接口但不更新调用方与文档。
- 红旗：错误情况与边界行为未定义。
- 偷懒：用「和原来一样」代替明确契约。
- 偷懒：破坏性变更不标注、不评估影响。

## Verification

- Interface Contract 字段完整并写入 spec。
- 实际实现与契约一致，边界行为已覆盖。
- 受影响调用方已识别并处理。
