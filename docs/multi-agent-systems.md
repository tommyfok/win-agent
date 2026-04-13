# 构建多智能体系统：何时以及如何使用

> 原文：[Building multi-agent systems: When and how to use them](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them)  
> 分类：智能体 · 产品：Claude Platform、Claude Code · 日期：2026 年 1 月 23 日 · 阅读约 5 分钟

虽然单智能体系统能有效处理大多数企业工作流，多智能体架构仍能为组织带来额外价值。本文说明何时以及如何使用它们。

---

多智能体系统是一种架构：多个 LLM 实例在**各自独立的对话上下文**中运行，并通过代码进行协调。存在多种协调模式（智能体群、基于能力的系统、消息总线架构等），但本文聚焦**编排器–子智能体（orchestrator-subagent）**模式：由主智能体为具体子任务创建并管理专职子智能体的层级模型。该模式协调方式直观，适合刚接触多智能体系统的团队。其他模式将在下一篇文章中详述。

如今，多智能体常被用在**单智能体其实会表现更好**的场景里，但随着模型能力提升，这种取舍也在变化。在 Anthropic，我们见过团队花数月搭建复杂多智能体架构，最后却发现**在单智能体上改进提示**就能达到同等效果。

在构建多智能体并与生产部署团队合作之后，我们归纳出三类**多智能体稳定优于单智能体**的情况：**上下文污染**拖累表现时、任务可**并行**时、以及**专业化**能改善工具选择或任务专注度时。在这些情况之外，协调成本往往大于收益。

本文将分享：如何识别单智能体的边界、多智能体在哪些场景真正占优，以及如何避免常见实现误区。

## 为何先从单智能体开始

设计得当、工具匹配的单智能体，能完成的工作往往超出许多开发者的预期。

多智能体会带来**开销**。每多一个智能体，就多一个潜在故障点、多一套要维护的提示词、多一种意外行为来源。

我们观察到：团队为规划、执行、评审、迭代分别建智能体，结果在每次交接时**丢失上下文**，花在协调上的 token 比执行还多。在我们的测试中，对**同等任务**，多智能体实现通常比单智能体多消耗 **3～10 倍** token。开销来自：跨智能体重复上下文、智能体之间的协调消息、以及为交接做的结果摘要。

## 多智能体决策框架

当多智能体架构能化解**单智能体无法解决的特定约束**时，它才创造价值。因此应只在**收益明确、足以覆盖额外成本**时使用。

下面几类模式，是我们**持续看到正向回报**的投资方向。

### 上下文保护

大语言模型的上下文窗口有限，上下文变长时回答质量可能下降。当一个子任务产生的信息**与后续子任务无关**却仍堆进上下文时，就会发生**上下文污染**。子智能体提供**隔离**：各自在干净、聚焦自身任务的上下文中运行。

设想客服智能体既要查订单历史，又要诊断技术问题。若每次查单都把数千 token 写进上下文，智能体推理技术问题的能力就会变差。

**单智能体做法：**

```javascript
# Single agent accumulates everything in context
conversation_history = [
    {"role": "user", "content": "My order #12345 isn't working"},
    {"role": "assistant", "content": "Let me check your order..."},
    # Tool result adds 2000+ tokens of order history
    {"role": "user", "content": "... (order details, past purchases, shipping info) ..."},
    {"role": "assistant", "content": "Now let me diagnose the technical issue..."},
    # Context is now polluted with order details the agent doesn't need
]
```

智能体必须在脑中保留 2000+ token 无关订单信息的同时推理技术问题，注意力被稀释，回答质量下降。

**多智能体做法：**

```javascript
from anthropic import Anthropic

client = Anthropic()

class OrderLookupAgent:
    def lookup_order(self, order_id: str) -> dict:
        # Separate agent with its own context
        messages = [
            {"role": "user", "content": f"Get essential details for order {order_id}"}
        ]
        response = client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=1024,
            messages=messages,
            tools=[get_order_details_tool]
        )
        # Returns only essential information
        return extract_summary(response)

class SupportAgent:
    def handle_issue(self, user_message: str):
        if needs_order_info(user_message):
            order_id = extract_order_id(user_message)
            # Get only what's needed, not full history
            order_summary = OrderLookupAgent().lookup_order(order_id)
            # Inject compact summary, not full context
            context = f"Order {order_id}: {order_summary['status']}, purchased {order_summary['date']}"
        
        # Main agent context stays clean
        messages = [
            {"role": "user", "content": f"{context}\n\nUser issue: {user_message}"}
        ]
        response = client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=2048,
            messages=messages
        )
        return response
```

订单查询智能体处理完整订单历史并抽取摘要；主智能体只收到真正需要的约 50～100 token，上下文保持聚焦。

当子任务产生**大量上下文（如超过 1000 token）**但其中**大部分与主任务无关**、子任务边界清晰且**抽取标准明确**、或属于需要先过滤再使用的**查找/检索**时，上下文隔离最有效。

### 并行化

并行运行多个智能体，可以探索**比单个智能体更大的搜索空间**。该模式在搜索与研究类任务中尤其有价值。

我们的 [Research 功能](https://www.anthropic.com/engineering/multi-agent-research-system) 采用这一思路：主智能体分析查询，并并行派出多个子智能体分头调研不同侧面；各子智能体独立搜索后返回提炼结果。多智能体搜索通过在更大信息空间中探索，相较单智能体在准确率上有明显提升。

核心实现是：把问题拆成彼此独立的侧面，并发运行子智能体，再汇总结果。

```javascript
import asyncio
from anthropic import AsyncAnthropic

client = AsyncAnthropic()

async def research_topic(query: str) -> dict:
    # Lead agent breaks query into research facets
    facets = await lead_agent.decompose_query(query)
    
    # Spawn subagents to research each facet in parallel
    tasks = [
        research_subagent(facet) 
        for facet in facets
    ]
    results = await asyncio.gather(*tasks)
    
    # Lead agent synthesizes findings
    return await lead_agent.synthesize(results)

async def research_subagent(facet: str) -> dict:
    """Each subagent has its own context window"""
    messages = [
        {"role": "user", "content": f"Research: {facet}"}
    ]
    response = await client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=4096,
        messages=messages,
        tools=[web_search, read_document]
    )
    return extract_findings(response)
```

这种覆盖面的提升有代价：对同等任务，多智能体通常比单智能体多消耗 **3～10 倍** token——每个智能体需要自己的上下文、智能体之间要交换消息、交接时要摘要。并行虽能相对「全部串行」缩短墙钟时间，但由于总计算量剧增，多智能体**整体耗时**往往仍长于单智能体。

并行化的主要收益是**更全面**，而非单纯更快。当你需要在巨大信息空间中搜索，或从多个角度审视复杂问题时，并行智能体能比在上下文限制下单打独斗覆盖更多地面。代价是更高的 token 消耗，且总执行时间常常更长，以换取更完整的结果。

### 专业化

不同任务有时需要不同的工具集、系统提示词或领域专长。与其让一个智能体挂几十个工具，不如让**职责与工具集匹配**的专职智能体协同，往往更可靠。

#### 工具集专业化

工具过多会拖累表现。出现以下信号时，值得考虑工具专业化：

1. **数量**：工具过多（常见如 20+）时，难以选对工具。  
2. **领域混淆**：工具跨多个无关领域（数据库、API、文件系统等）时，智能体容易搞混该用哪一类。  
3. **性能退化**：新工具加入后，原有任务表现变差，说明智能体在工具管理上的承载已接近上限。

#### 系统提示词专业化

不同任务可能需要不同人设、约束或指令，合在一起会**冲突**。客服要共情、耐心；代码评审要精确、挑剔；合规检查要严守规则；头脑风暴要灵活创意。若同一智能体要在多种冲突行为模式间切换，拆成**提示词定制**的专职智能体，结果更稳定。

#### 领域专长专业化

有些任务需要很深的领域上下文，会压垮通才智能体。法律分析可能需要大量判例与监管框架；医学研究可能需要临床试验方法等专识。与其把所有领域上下文塞进一个智能体，不如让各专职智能体只携带与其职责相关的聚焦知识。

**示例：多平台集成。** 智能体需同时对接 CRM、营销自动化、消息平台；每个平台各有约 10～15 个相关 API 端点。一个智能体挂 40+ 工具时，常选错工具，把跨平台的相似操作搞混。拆成工具集与提示词都聚焦的专职智能体，可减少选型错误。

```javascript
from anthropic import Anthropic

client = Anthropic()

# Specialized agents with focused toolsets and tailored prompts
class CRMAgent:
    """Handles customer relationship management operations"""
    system_prompt = """You are a CRM specialist. You manage contacts, 
    opportunities, and account records. Always verify record ownership 
    before updates and maintain data integrity across related records."""
    tools = [
        crm_get_contacts,
        crm_create_opportunity,
        # 8-10 CRM-specific tools
    ]

class MarketingAgent:
    """Handles marketing automation operations"""
    system_prompt = """You are a marketing automation specialist. You 
    manage campaigns, lead scoring, and email sequences. Prioritize 
    data hygiene and respect contact preferences."""
    tools = [
        marketing_get_campaigns,
        marketing_create_lead,
        # 8-10 marketing-specific tools
    ]

class OrchestratorAgent:
    """Routes requests to specialized agents"""
    def execute(self, user_request: str):
        response = client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=1024,
            system="""You coordinate platform integrations. Route requests to the appropriate specialist:
- CRM: Contact records, opportunities, accounts, sales pipeline
- Marketing: Campaigns, lead nurturing, email sequences, scoring
- Messaging: Notifications, alerts, team communication""",
            messages=[
                {"role": "user", "content": user_request}
            ],
            tools=[delegate_to_crm, delegate_to_marketing, delegate_to_messaging]
        )
        return response
```

这与现实中「专家各掌其器」的协作类似，往往比通才硬扛所有领域更有效。但专业化会带来**路由复杂度**：编排器必须正确分类并委派；**误路由**会导致糟糕结果；维护多套提示也有额外成本。当领域边界清晰、路由判据明确时，专业化最奏效。

## 何时说明单智能体架构已不够用

除上述框架外，还有一些**具体信号**表明单智能体模式已到极限：

**逼近上下文上限。** 若智能体经常占用大量上下文且表现下滑，瓶颈可能在上下文压力。注意：上下文管理方面的进展（例如[压缩/compaction](https://platform.claude.com/cookbook/tool-use-automatic-context-compaction)）正在缓解这一限制，使单智能体能在更长跨度上保持有效「记忆」。

**管理大量工具。** 当工具有 15～20+ 个时，模型会花大量上下文与注意力理解选项。在采用多智能体之前，可先考虑 [Tool Search Tool](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/tool-search-tool)：让 Claude **按需发现工具**，而非一次性加载全部定义，可[最多减少约 85% 的 token 使用](https://www.anthropic.com/engineering/advanced-tool-use)，并提升工具选择准确率。

**可并行的子任务。** 当任务自然拆成彼此独立的几块（多源研究、多组件测试等）时，并行子智能体能带来明显加速。

这些阈值会随模型进化而变；当前数字是**实践参考**，不是铁律。

## 以上下文为中心的分解

采用多智能体时，**如何在智能体之间切分工作**是最重要的设计决策。我们常见团队切错，导致协调开销抵消多智能体收益。

关键洞见是：分解工作时应采用**上下文中心**视角，而非**问题类型中心**视角。

**按问题类型分解（往往适得其反）。** 例如一个写功能、一个写测试、一个审代码——会带来持续协调成本。每次交接都丢上下文：写测试的不清楚某些实现决策的原因，审代码的缺少探索与迭代的上下文。

**按上下文边界分解（通常更有效）。** 负责某功能的智能体也应负责其测试，因为它已掌握所需上下文。只有在上下文**真能隔离**时才应拆分。

这来自对多智能体失败模式的观察：按角色拆分时，会像**传话游戏**，信息来回传递，每次交接都损失保真度。在一次按软件角色（规划、实现、测试、评审）专精的实验中，子智能体花在协调上的 token 甚至多于实际工作。

**较健康的分解边界包括：**

- **独立研究路径**：例如「亚洲市场趋势」与「欧洲市场趋势」可并行、无共享上下文。  
- **接口清晰的不同组件**：有明确 API 契约时，前后端可并行。  
- **黑盒验证**：验证者只需跑测试并汇报结果，不需要实现细节上下文。

**有问题的分解边界包括：**

- **同一工作的串行阶段**：同一功能的规划、实现、测试共享过多上下文。  
- **紧耦合组件**：需要频繁来回沟通的应放在同一智能体内。  
- **需要共享状态的工作**：若需频繁对齐理解，应留在同一智能体中。

## 验证子智能体模式

在各类场景中一贯有效的一种模式是**验证子智能体（verification subagent）**：专职负责测试或校验主智能体产出的智能体。

能力更强的编排模型（如 Claude Opus 4.5）已越来越多能**直接评估**子智能体工作而无需单独验证步骤。但在编排器能力较弱、验证需要专用工具、或你希望在工作流中**强制显式验证检查点**时，验证子智能体仍有价值。

验证子智能体能避开传话问题：验证本身只需**极少上下文传递**，验证者可以黑盒测试系统，而不必了解构建全过程。

### 实现方式

主智能体完成一个工作单元；在继续之前，它创建一个验证子智能体，传入待验证产物、明确的成功标准以及执行验证所需的工具。

验证者不必理解「为何这样实现」，只需判断产物是否满足既定标准。

```javascript
from anthropic import Anthropic

client = Anthropic()

class CodingAgent:
    def implement_feature(self, requirements: str) -> dict:
        """Main agent implements the feature"""
        messages = [
            {"role": "user", "content": f"Implement: {requirements}"}
        ]
        response = client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=4096,
            messages=messages,
            tools=[read_file, write_file, list_directory]
        )
        return {
            "code": response.content,
            "files_changed": extract_files(response)
        }

class VerificationAgent:
    def verify_implementation(self, requirements: str, files_changed: list) -> dict:
        """Separate agent verifies the work"""
        messages = [
            {"role": "user", "content": f"""
Requirements: {requirements}
Files changed: {files_changed}

Run the test suite and verify:
1. All existing tests pass
2. New functionality works as specified
3. No obvious errors or security issues

You MUST run the complete test suite before marking as passed.
Do not mark as passing after only running a few tests.
Run: pytest --verbose
Only mark as PASSED if ALL tests pass with no failures.
"""}
        ]
        response = client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=4096,
            messages=messages,
            tools=[run_tests, execute_code, read_file]
        )
        return {
            "passed": extract_pass_fail(response),
            "issues": extract_issues(response)
        }

def implement_with_verification(requirements: str, max_attempts: int = 3):
    for attempt in range(max_attempts):
        result = CodingAgent().implement_feature(requirements)
        verification = VerificationAgent().verify_implementation(
            requirements,
            result['files_changed']
        )
        
        if verification['passed']:
            return result
        
        requirements += f"\n\nPrevious attempt failed: {verification['issues']}"
    
    raise Exception(f"Failed verification after {max_attempts} attempts")
```

### 适用场景

验证子智能体适用于：

- **质量保证**：跑测试套件、Lint、按 schema 校验输出。  
- **合规检查**：核对文档是否符合策略、输出是否符合规则。  
- **输出校验**：交付前确认生成内容符合规格。  
- **事实核查**：由单独智能体验证生成内容中的主张或引用。

### 「过早胜利」问题

验证子智能体最大的失败模式是：**未充分测试就标为通过**——只跑一两项测试看见通过就宣布成功。

缓解策略包括：

- **具体标准**：写「运行完整测试套件并报告所有失败」，而不是笼统的「确保能用」。  
- **全面检查**：要求验证者覆盖多种场景与边界情况。  
- **负例测试**：要求验证者对「应失败」的输入进行尝试并确认确实失败。  
- **明确指令**：「必须先运行完整测试套件再标为通过」这类要求必不可少；没有全面验证的硬性规定时，验证智能体会走捷径。

## 下一步

多智能体很强大，但并非放之四海而皆准。在引入多智能体协调的复杂度之前，请确认：

1. **确实存在**需要多智能体解决的约束（上下文限制、并行机会或专业化需求）。  
2. **分解依据是上下文，而非工种**：按「需要什么上下文」分组，而不是按「干什么活」分组。  
3. **存在清晰的验证点**，子智能体可在不掌握完整上下文的情况下完成校验。

我们的建议？从**能跑通的最简单方案**开始，仅在**有证据表明需要**时再增加复杂度。

本文为多智能体系列第一篇。单智能体模式详见 [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)；上下文管理策略见 [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)；多智能体研究系统的构建见 [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)。

## 致谢

作者：Cara Phillips；贡献者：Paul Chen、Andy Schumeister、Brad Abrams、Theo Chu。
