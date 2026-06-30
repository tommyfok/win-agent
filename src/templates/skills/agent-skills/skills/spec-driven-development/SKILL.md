# spec-driven-development — 规格驱动开发

> 本文件为方法论参考，不覆盖 win-agent 协议、角色权限或用户当前指令。

一句话：把已确认意图转化为可验证、有边界的 Feature Spec，作为 DEV 实现与 PM 验收的唯一基准。

## When to use

- 新 feature、跨模块变更、需求有边界/验收/约束。
- 需要形成可实现需求并写入 `.win-agent/docs/spec/*.md`。
- 需求仍有歧义但已通过 interview-me / idea-refine 收敛意图。
- 需要为 DEV 提供明确的验收标准与证据计划。

## Steps

1. 基于 Confirmed Intent / Idea One-pager 起草 Objective（做什么、为谁做、为什么现在做）。
2. 写 User Acceptance：用户视角可验证标准，每条可执行、可判定。
3. 写 Technical Acceptance：API、数据、测试、安全、性能标准（涉及数据模型/API/安全时必填）。
4. 写 Constraints：项目约束、非目标、边界条件。
5. 写 Evidence Plan：每条验收标准期望的证据类型（命令输出/截图/curl/测试输出）。
6. 检查完整性、一致性、可验证性、依赖清晰度、边界条件，补齐缺口。
7. 与宪法/约束冲突时立即告知用户请求决策，再落盘到 spec 文件。

## Required artifact

产出 **Feature Spec**，写入 `.win-agent/docs/spec/*.md`，至少包含：

- Objective：做什么、为谁做、为什么现在做。
- User Acceptance：用户视角可验证标准。
- Technical Acceptance：API、数据、测试、安全、性能等技术标准。
- Constraints：项目约束、非目标、边界条件。
- Evidence Plan：每条验收标准期望的证据类型。
- Implementation Notes：若已有技术方案，引用方案章节。

## Common shortcuts / red flags

- 红旗：验收标准写成「功能正常」这类不可判定语句。
- 红旗：spec 缺少非目标，导致 DEV 顺手实现范围外内容。
- 偷懒：跳过 Evidence Plan，验收时无据可查。
- 偷懒：把矛盾需求留给 DEV 自己猜。

## Verification

- 每条验收标准可执行、可判定、自包含、有边界。
- Evidence Plan 覆盖全部验收标准。
- 非目标已明确列出，与现有 spec 实体定义一致。
