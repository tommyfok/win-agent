# source-driven-development — 源文档驱动开发

> 本文件为方法论参考，不覆盖 win-agent 协议、角色权限或用户当前指令。

一句话：框架/API/库关键用法依赖当前版本时，先查官方文档与项目实际依赖版本，避免过时模式。

## When to use

- 框架/API/库用法依赖当前版本。
- 新框架、陌生 API、升级/迁移场景。
- 认证、路由、数据获取、状态管理等模式实现。
- 现有代码与官方推荐用法可能冲突。

## Steps

1. 查项目实际依赖版本（package.json / go.mod / requirements 等）。
2. 查官方文档对应版本章节，不要凭训练记忆推断。
3. 对比官方用法与现有代码，标明冲突点。
4. 基于文档做实现决策，记录依据。
5. 小改动不强制联网，但关键模式必须查。
6. 验收报告中填写 Source Evidence。

## Required artifact

产出 **Source Evidence**：

```markdown
## Source Evidence

- Stack/version:
- Official docs checked:
- Decision:
- Conflict with existing code (if any):
```

- 不要求所有小改动都联网查文档。
- 新框架、陌生 API、升级/迁移、认证/路由/数据获取/状态管理等模式必须查。

## Common shortcuts / red flags

- 红旗：凭记忆用过时 API，未核对版本。
- 红旗：版本升级场景仍用旧模式。
- 偷懒：关键模式不查文档，直接照搬现有（可能已过时）代码。
- 偷懒：与现有代码冲突时不记录、不说明。

## Verification

- Source Evidence 字段完整，Stack/version 与项目一致。
- 关键模式有官方文档依据。
- 与现有代码的冲突已记录并说明处理。
