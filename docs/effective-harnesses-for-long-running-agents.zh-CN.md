# 长时间运行 Agent 的有效执行框架

> 原文：[Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
> 作者：Justin Young
> 发布日期：2025-11-26
> 本文为中文翻译。

随着 AI agent 能力越来越强，开发者越来越多地要求它们承担复杂任务，这些任务往往需要持续数小时，甚至数天。不过，如何让 agent 在多个上下文窗口之间保持稳定进展，仍然是一个开放问题。

长时间运行 agent 的核心挑战在于：它们必须以离散会话的形式工作，而每个新会话一开始都没有之前发生过什么的记忆。可以想象一个由轮班工程师组成的软件项目，每位新来的工程师都不知道上一班发生了什么。由于上下文窗口有限，而大多数复杂项目又无法在单个窗口里完成，agent 需要一种办法来弥合不同编码会话之间的断层。

我们开发了一套双重方案，让 [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview) 能够跨多个上下文窗口有效工作：一个在首次运行时设置环境的 **initializer agent**，以及一个在每个会话中负责取得增量进展、并为下一次会话留下清晰产物的 **coding agent**。你可以在配套的 [quickstart](https://github.com/anthropics/claude-quickstarts/tree/main/autonomous-coding) 中找到代码示例。

## 长时间运行 Agent 的问题

Claude Agent SDK 是一个强大、通用的 agent 执行框架，擅长编码，也适合其他需要模型使用工具来收集上下文、规划并执行的任务。它具备上下文管理能力，例如压缩，这使 agent 能够在执行任务时避免耗尽上下文窗口。理论上，在这种设置下，agent 应该能够在任意长的时间内持续做有用的工作。

然而，压缩并不够。开箱即用时，即便是像 Opus 4.5 这样的前沿编码模型，如果只是拿到一个高层提示，例如“构建一个 [claude.ai](http://claude.ai/redirect/website.v1.61a9cc1e-6b1b-4f4b-8fff-a533f8eaf633) 的克隆”，然后在 Claude Agent SDK 上跨多个上下文窗口循环运行，也不足以构建出生产质量的 Web 应用。

Claude 的失败表现为两种模式。首先，agent 倾向于一次做太多，基本上是试图一口气把整个应用做完。这常常导致模型在实现过程中途耗尽上下文，让下一次会话面对一个半实现、且没有文档说明的功能。于是 agent 不得不猜测之前发生了什么，并花大量时间重新让基础应用运行起来。即便有压缩，这种情况也会发生，因为压缩并不总能把完全清楚的指令传递给下一个 agent。

第二种失败模式常常发生在项目后期。当一些功能已经构建完成之后，后续某个 agent 实例会四处查看，发现已经取得了一些进展，然后宣布任务完成。

这把问题拆成了两部分。首先，我们需要设置一个初始环境，为某个提示所要求的 *所有* 功能打好基础，让 agent 能够一步一步、一个功能接一个功能地工作。其次，我们应该提示每个 agent 朝目标取得增量进展，同时在会话结束时让环境保持干净状态。所谓“干净状态”，指的是那种适合合并到主分支的代码状态：没有重大 bug，代码井然有序且文档良好，并且一般来说，开发者可以轻松开始做一个新功能，而不需要先清理无关的烂摊子。

在内部实验中，我们用一个两部分方案解决这些问题：

1. Initializer agent：第一个 agent 会话使用专门的提示，让模型设置初始环境：一个 `init.sh` 脚本、一个记录 agent 做过什么的 `claude-progress.txt` 文件，以及一个展示新增文件的初始 git 提交。
2. Coding agent：之后的每个会话都会要求模型取得增量进展，然后留下结构化更新。[^1]

这里的关键洞见是：要找到一种方法，让 agent 在带着全新的上下文窗口启动时，能够快速理解当前工作状态。这是通过 `claude-progress.txt` 文件和 git 历史共同完成的。这些实践的灵感来自于高效软件工程师每天都会做的事情。

## 环境管理

在更新后的 [Claude 4 提示指南](https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/claude-4-best-practices#multi-context-window-workflows) 中，我们分享了一些多上下文窗口工作流的最佳实践，其中包括一种执行框架结构：它会为“第一个上下文窗口使用不同的提示”。这个“不同的提示”要求 initializer agent 设置好环境，并放入未来 coding agent 高效工作所需的全部必要上下文。这里，我们更深入地介绍这种环境的几个关键组成部分。

### 功能清单

为了解决 agent 一次性把应用做完，或过早认为项目已经完成的问题，我们提示 initializer agent 编写一份全面的功能需求文件，对用户的初始提示进行扩展。在 [claude.ai](http://claude.ai/redirect/website.v1.61a9cc1e-6b1b-4f4b-8fff-a533f8eaf633) 克隆示例中，这意味着超过 200 个功能，例如“用户可以打开一个新聊天，输入查询，按下回车，然后看到 AI 回复”。这些功能一开始都被标记为“失败”，这样后续 coding agent 就能清楚看到完整功能应该是什么样子。

```json
{
    "category": "functional",
    "description": "New chat button creates a fresh conversation",
    "steps": [
      "Navigate to main interface",
      "Click the 'New Chat' button",
      "Verify a new conversation is created",
      "Check that chat area shows welcome state",
      "Verify conversation appears in sidebar"
    ],
    "passes": false
  }
```

我们提示 coding agent 只能通过修改 `passes` 字段的状态来编辑这个文件，并使用措辞很强的指令，例如“删除或编辑测试是不可接受的，因为这可能导致功能缺失或有 bug。”经过一些实验后，我们最终选择使用 JSON 来做这件事，因为与 Markdown 文件相比，模型不太可能不恰当地修改或覆盖 JSON 文件。

### 增量进展

有了这个初始环境脚手架之后，下一轮 coding agent 会被要求一次只处理一个功能。这种增量式方法后来被证明对解决 agent 一次做太多的倾向至关重要。

一旦开始增量工作，在做完代码变更后，让模型把环境保持在干净状态仍然很重要。在我们的实验中，我们发现诱导这种行为的最佳方法，是要求模型用描述性的提交信息把进展提交到 git，并在进度文件中写下进展摘要。这样模型就能使用 git 回退糟糕的代码变更，并恢复代码库的可工作状态。

这些方法也提高了效率，因为它们消除了 agent 不得不猜测之前发生了什么、并把时间花在重新让基础应用运行起来上的需要。

### 测试

我们观察到的最后一个主要失败模式，是 Claude 往往会在没有适当测试的情况下把某个功能标记为完成。如果没有明确提示，Claude 倾向于修改代码，甚至会用单元测试或针对开发服务器的 `curl` 命令做测试，但却没有意识到这个功能并没有端到端地工作。

在构建 Web 应用的场景中，一旦明确提示 Claude 使用浏览器自动化工具，并像人类用户一样完成所有测试，Claude 在端到端验证功能方面整体表现不错。

> 图片说明：Claude 通过 Puppeteer MCP 服务器测试 claude.ai 克隆时截取的屏幕截图。

为 Claude 提供这类测试工具显著提升了表现，因为 agent 能够识别并修复那些仅从代码本身并不明显的 bug。

仍然有一些问题存在，例如 Claude 视觉能力的限制，以及浏览器自动化工具的限制，会让识别每一种 bug 变得困难。举例来说，Claude 无法通过 Puppeteer MCP 看到浏览器原生的警告弹窗，因此依赖这些弹窗的功能往往更容易出现 bug。

## 快速进入状态

在上述所有内容都就位后，每个 coding agent 都会被提示执行一系列步骤来找准方位，其中有些步骤相当基础，但仍然很有帮助：

1. *运行 `pwd` 查看你正在工作的目录。你只能编辑这个目录中的文件。*
2. *阅读 git 日志和进度文件，快速了解最近做过什么。*
3. *阅读功能清单文件，并选择最高优先级、尚未完成的功能来处理。*

这种方法可以在每个会话中为 Claude 节省一些 token，因为它不必重新弄清楚如何测试代码。让 initializer agent 编写一个 `init.sh` 脚本也很有帮助，这个脚本可以运行开发服务器，并在实现新功能之前完成一次基础端到端测试。

在 claude.ai 克隆的例子中，这意味着 agent 总是会启动本地开发服务器，并使用 Puppeteer MCP 开始一个新聊天、发送一条消息、接收一个回复。这保证了 Claude 能够快速识别应用是否被上一轮留在了损坏状态，并立即修复现有 bug。如果 agent 反而开始实现新功能，很可能会让问题变得更糟。

基于这一切，一个典型会话会从下面这些 assistant 消息开始：

```text
[Assistant] I'll start by getting my bearings and understanding the current state of the project.
[Tool Use] <bash - pwd>
[Tool Use] <read - claude-progress.txt>
[Tool Use] <read - feature_list.json>
[Assistant] Let me check the git log to see recent work.
[Tool Use] <bash - git log --oneline -20>
[Assistant] Now let me check if there's an init.sh script to restart the servers.
<Starts the development server>
[Assistant] Excellent! Now let me navigate to the application and verify that some fundamental features are still working.
<Tests basic functionality>
[Assistant] Based on my verification testing, I can see that the fundamental functionality is working well. The core chat features, theme switching, conversation loading, and error handling are all functioning correctly. Now let me review the tests.json file more comprehensively to understand what needs to be implemented next.
<Starts work on a new feature>
```

> 图片标题：Agent 失败模式与解决方案
>
> 图片说明：总结长时间运行 AI agent 中四种常见失败模式及其解决方案。

## 未来工作

这项研究展示了长时间运行 agent 执行框架中一组可能的解决方案，使模型能够跨多个上下文窗口取得增量进展。不过，仍然存在一些开放问题。

最值得注意的是，目前仍不清楚单一的通用 coding agent 是否在跨上下文工作时表现最好，还是说通过多 agent 架构能够取得更好的表现。看起来，测试 agent、质量保障 agent 或代码清理 agent 这样的专门 agent，有可能在软件开发生命周期中的子任务上做得更好。

此外，这个演示针对全栈 Web 应用开发进行了优化。未来的一个方向，是把这些发现推广到其他领域。很可能这些经验中的一部分或全部，都可以应用到其他类型的长时间 agent 任务中，例如科学研究或金融建模。

### 致谢

本文由 Justin Young 撰写。特别感谢 David Hershey、Prithvi Rajasakeran、Jeremy Hadfield、Naia Bouscal、Michael Tingley、Jesse Mu、Jake Eaton、Marius Buleandara、Maggie Vo、Pedram Navid、Nadine Yasser 和 Alex Notov 的贡献。

这项工作反映了 Anthropic 多个团队的集体努力，正是这些努力让 Claude 能够安全地完成长周期自主软件工程，尤其是 code RL 和 Claude Code 团队。欢迎有兴趣参与贡献的候选人在 [anthropic.com/careers](http://anthropic.com/careers) 申请职位。

## 脚注

[^1]: 我们在这里把它们称为不同的 agent，只是因为它们有不同的初始用户提示。除此之外，系统提示、工具集合和整体 agent 执行框架都是相同的。
