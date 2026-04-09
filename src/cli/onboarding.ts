import fs from 'node:fs';
import path from 'node:path';
import { input, confirm } from '@inquirer/prompts';
import { runEnvCheck } from './check.js';
import { initWorkspace, detectExistingCode, detectSubProjects } from '../workspace/init.js';
import { openDb, closeDb, getDb } from '../db/connection.js';
import { select as dbSelect, insert as dbInsert, update as dbUpdate } from '../db/repository.js';
import {
  syncAgents,
  deployTools,
  ensureRequiredMcps,
} from '../workspace/sync-agents.js';
import { insertKnowledge } from '../embedding/knowledge.js';
import { getEmbeddingDimension } from '../embedding/index.js';
import { setEmbeddingDimension } from '../db/schema.js';
import { getDbPath } from '../config/index.js';
import { startOpencodeServer, removeServerInfo } from '../engine/opencode-server.js';

/** Machine-detectable marker for content that needs user review */
export const TODO_MARKER_REGEX = /⚠️ \*\*TODO\*\*/;

/** Check whether a file contains TODO markers that need user attention */
export function hasTodoMarkers(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf-8');
  return TODO_MARKER_REGEX.test(content);
}

/**
 * Strip any preamble text before the first markdown heading in LLM output.
 * LLMs sometimes produce conversational filler like "现在我来生成文档了。" before the actual content.
 */
export function cleanOverviewOutput(raw: string): string {
  const match = raw.match(/^([\s\S]*?)(##\s)/);
  if (match && match[1].trim().length > 0) {
    // There's non-empty text before the first ## heading — strip it
    return raw.slice(match.index! + match[1].length);
  }
  return raw;
}

export function buildWorkspaceAnalysisPrompt(subProjects: string[]): string {
  const isMonorepo = subProjects.length > 0;
  const subProjectList = subProjects.map((p) => `  - ${p}`).join('\n');

  const monorepoSection = isMonorepo
    ? `

**重要：这是一个 Monorepo 项目，包含以下子项目：**
${subProjectList}

你必须逐个进入每个子项目目录，读取其 package.json / Makefile / 配置文件等，分析其独立的技术栈和开发命令。不要只看根目录。`
    : '';

  const chaptersSection = isMonorepo
    ? `请直接输出 Markdown 格式的概览文档，必须包含以下章节：
## 整体架构
  描述各子项目之间的关系和整体架构
## 子项目明细
  对每个子项目分别输出以下内容（使用三级标题 ### 子项目名）：
  ### <子项目名>
  - **类型与技术栈**：项目类型、使用的语言/框架
  - **目录结构**：关键路径
  - **主要模块**：功能划分
  - **开发命令**（必须实际读取 package.json 等确认真实命令）：
    - 安装依赖
    - 构建命令
    - 启动/开发命令
    - Lint 命令
    - 测试命令
    - 其他开发相关命令
    没有的标注"无"
## 共享配置与约定
  跨子项目的共享配置、公共依赖、统一规范等（如有）`
    : `请直接输出 Markdown 格式的概览文档，必须包含以下章节：
## 技术栈
## 目录结构（关键路径）
## 主要模块
## 开发人员工作流程
  该章节必须包含以下内容（根据项目实际情况填写，没有的标注"无"）：
  - 构建命令（如 npm run build）
  - Lint 命令（如 npm run lint）
  - 单元测试命令（如 npm test）
  - 集成测试/E2E 测试命令（如有）
  - 其他开发相关命令`;

  return `请分析当前工作空间，生成一份项目技术概览文档。

按以下步骤扫描项目（严格使用给定的 glob 模式，禁止扫描 \`.\` 开头的目录）：

Step 1 — 了解项目顶层结构：
  glob("[!.]*")

Step 2 — 定位关键配置文件：
  glob("[!.]*/package.json")
  glob("[!.]*/tsconfig.json")
  glob("[!.]*/Makefile")
  glob("[!.]*/Dockerfile")
  glob("[!.]*/go.mod")
  glob("[!.]*/Cargo.toml")
  glob("[!.]*/pyproject.toml")
  也读取根目录的 package.json、README.md、CONTRIBUTING.md（如果存在）

Step 3 — 了解源码目录结构：
  glob("[!.]*/**/*", 仅浏览目录层级，不需要读取每个源文件)

Step 4 — read 读取 Step 2 中找到的配置文件，提取技术栈和命令信息

重点了解：
1. 项目类型和主要技术栈
2. 目录结构和关键文件
3. 主要模块/功能划分
4. 依赖和配置情况
5. 开发工作流程：构建、lint、测试命令（必须实际读取 package.json / Makefile 等确认真实命令）
${monorepoSection}

${chaptersSection}

严格要求：直接以 Markdown 正文开头（即以 ## 标题开头），禁止输出任何过渡性语句、思考过程或额外解释（如"现在我来生成文档"、"我已经分析完毕"等）。`;
}

export function buildDevelopmentDocPrompt(subProjects: string[]): string {
  const isMonorepo = subProjects.length > 0;
  const subProjectList = subProjects.map((p) => `  - ${p}`).join('\n');

  const monorepoNote = isMonorepo
    ? `\n**重要：这是一个 Monorepo 项目，包含以下子项目：**
${subProjectList}
你必须逐个分析每个子项目的配置，在相关章节下使用三级标题 ### 子项目名 分别说明。`
    : '';

  return `请分析当前工作空间，生成一份面向 AI 开发 Agent 的开发指南文档。

**核心目标**：这份文档将被 AI Agent 在执行开发任务时参考，因此内容必须是明确、可执行的步骤和命令，而非描述性的规范说明。

按以下步骤扫描项目（严格使用给定的 glob 模式，禁止扫描 \`.\` 开头的目录）：

Step 1 — 定位配置文件：
  glob("[!.]**/package.json")
  glob("[!.]**/tsconfig.json")
  glob("[!.]**/jsconfig.json")
  glob("[!.]**/.eslintrc*")
  glob("[!.]**/prettier.config*")
  glob("[!.]**/biome.json")
  glob("[!.]**/Dockerfile")
  glob("[!.]**/docker-compose*")
  glob("[!.]**/go.mod")
  glob("[!.]**/Cargo.toml")
  glob("[!.]**/pyproject.toml")
  glob("[!.]**/pom.xml")
  也读取根目录的 README.md、CONTRIBUTING.md（如果存在）

Step 2 — read 读取 Step 1 中找到的文件，提取依赖、脚本命令、规范配置等信息
${monorepoNote}

请直接输出 Markdown 格式文档，包含以下章节：

## 技术栈

用一个简短的列表列出项目的核心技术栈（语言、框架、运行时、包管理器等）。例如：
- 语言：TypeScript
- 运行时：Node.js 20
- 框架：NestJS
- 包管理器：pnpm

## 开发命令

这是最重要的章节。必须基于 package.json / Makefile 等实际确认的命令，列出开发过程中需要用到的所有命令。格式为直接可执行的命令行，例如：

\`\`\`bash
# 安装依赖
pnpm install

# 开发模式启动
pnpm dev

# 构建
pnpm build

# Lint 检查
pnpm lint

# 运行测试
pnpm test
\`\`\`

如果有多个子项目，分别列出各子项目的命令。

## 开发流程

用**编号步骤**描述 Agent 拿到一个开发任务后应该遵循的标准流程。例如：
1. 阅读需求，理解要实现的功能
2. 确认相关的代码模块和文件位置
3. 编写代码实现功能
4. 运行 lint 检查并修复问题
5. 运行测试确认无回归
6. ...

根据项目实际情况调整步骤。如果项目配置了 pre-commit hooks / lint-staged 等，在相关步骤中提及。

## 技术栈最佳实践

根据检测到的技术栈，给出针对性的开发最佳实践要点。这些是 Agent 编码时应该遵循的原则。

**要求**：根据项目实际使用的技术栈来写，不同技术栈侧重点不同。例如：
- **TypeScript 项目**：类型安全要求、避免 any、使用严格模式等
- **React 项目**：组件设计模式、hooks 使用规范、状态管理方式等
- **Vue 项目**：组合式 API vs 选项式 API、组件通信方式等
- **NestJS 项目**：模块组织、依赖注入、DTO 验证等
- **Node.js 服务端**：错误处理、日志规范、中间件模式等
- **Go 项目**：错误处理模式、并发模式、项目布局等
- **Python 项目**：类型提示、虚拟环境、代码风格等

每条最佳实践应该简短明确（1-2 句话），列出 5-10 条最重要的即可，不要面面俱到。

## 分支与提交规范

简要说明分支策略和提交规范。如果项目有 commitlint 等配置则基于实际配置写，否则标记 TODO。此章节尽量简短，3-5 行即可。

## 重要规则：TODO 标记
对于无法从项目中确定、需要用户补充的内容，必须使用以下格式标记：

> ⚠️ **TODO**: 请补充具体说明（这里写上你认为用户应该补充什么）

严格要求：直接以 ## 标题开头，禁止输出任何过渡性语句、思考过程或额外解释。`;
}

export function buildValidationDocPrompt(subProjects: string[]): string {
  const isMonorepo = subProjects.length > 0;
  const subProjectList = subProjects.map((p) => `  - ${p}`).join('\n');

  const monorepoNote = isMonorepo
    ? `\n**重要：这是一个 Monorepo 项目，包含以下子项目：**
${subProjectList}
你必须逐个分析每个子项目的测试配置。`
    : '';

  const perProjectSection = isMonorepo
    ? `
对每个子项目，在相应章节下使用三级标题 ### 子项目名，分别列出其测试情况。`
    : '';

  return `请分析当前工作空间，生成一份自测与验收规范文档。

按以下步骤扫描项目（严格使用给定的 glob 模式，禁止扫描 \`.\` 开头的目录）：

Step 1 — 定位测试相关配置文件：
  glob("[!.]**/jest.config*")
  glob("[!.]**/vitest.config*")
  glob("[!.]**/playwright.config*")
  glob("[!.]**/cypress.config*")
  glob("[!.]**/.nycrc*")
  glob("[!.]**/pytest.ini")
  glob("[!.]**/setup.cfg")
  glob("[!.]**/package.json")

Step 2 — 定位测试目录和 CI 配置：
  glob("[!.]**/__tests__/**/*")
  glob("[!.]**/test/**/*")
  glob("[!.]**/tests/**/*")
  glob("[!.]**/spec/**/*")
  glob("[!.]**/e2e/**/*")
  glob("[!.]**/.github/workflows/*")
  glob("[!.]**/Jenkinsfile")
  glob("[!.]**/.gitlab-ci.yml")

Step 3 — read 读取 Step 1-2 中找到的配置文件，提取测试框架、命令、覆盖率要求等信息
${monorepoNote}

请直接输出 Markdown 格式文档，必须包含以下章节：

## 自测要求
  基于实际扫描到的测试框架和配置填写：
  - 使用的测试框架及版本
  - 运行单元测试的命令
  - 测试覆盖率要求（如果配置中有）
  - 测试文件的命名和放置规范（基于现有测试文件的模式推断）
  如果项目没有测试框架，明确指出并标记 TODO。
${perProjectSection}

## E2E 验证
  如果项目配置了 E2E 测试框架则填写配置详情和运行命令，否则标记 TODO。

## 回归测试
  如果能从 CI 配置推断出回归测试策略则填写，否则标记 TODO。

## 验收标准
  标记 TODO（验收标准通常需要用户自行定义）。

## 重要规则：TODO 标记
对于无法从项目中确定、需要用户补充的内容，必须使用以下格式标记：

> ⚠️ **TODO**: 请补充具体说明（这里写上你认为用户应该补充什么）

例如：
> ⚠️ **TODO**: 请补充单元测试覆盖率的最低要求

严格要求：直接以 ## 标题开头，禁止输出任何过渡性语句、思考过程或额外解释。`;
}

export async function onboardingCommand() {
  try {
    await _onboardingCommand();
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err.name === 'ExitPromptError' || err.message?.includes('User force closed'))
    ) {
      console.log('\n👋 已取消');
      process.exit(0);
    }
    throw err;
  }
}

async function _onboardingCommand() {
  // ── 1️⃣ 环境检查 ──
  console.log('\n1️⃣  环境检查');
  const { workspace } = await runEnvCheck();
  setEmbeddingDimension(getEmbeddingDimension());

  // ── 2️⃣ 工作空间初始化 ──
  console.log('\n2️⃣  工作空间初始化');
  const initResult = initWorkspace(workspace);
  if (initResult.created) {
    console.log('   ✓ 工作空间已创建');
  } else {
    console.log('   ✓ 工作空间已存在');
  }

  const dbPath = getDbPath(workspace);
  try {
    getDb();
  } catch {
    openDb(dbPath);
  }

  // ── 3️⃣ 幂等检查 ──
  const alreadyDone = dbSelect<{ key: string; value: string }>('project_config', {
    key: 'onboarding_completed',
  });
  if (alreadyDone.length > 0) {
    const rerun = await confirm({ message: 'Onboarding 已完成过，是否重新运行？', default: false });
    if (!rerun) {
      console.log('   已跳过');
      closeDb();
      return;
    }
  }

  // ── 4️⃣ 项目信息 ──
  console.log('\n4️⃣  项目信息');
  const existingName =
    dbSelect<{ key: string; value: string }>('project_config', { key: 'projectName' })[0]?.value ??
    '';
  const existingDesc =
    dbSelect<{ key: string; value: string }>('project_config', { key: 'projectDescription' })[0]
      ?.value ?? '';

  const projectName = await input({ message: '项目名称', default: existingName });
  const projectDescription = await input({ message: '项目描述', default: existingDesc });

  if (existingName) {
    dbUpdate('project_config', { key: 'projectName' }, { value: projectName });
    dbUpdate('project_config', { key: 'projectDescription' }, { value: projectDescription });
  } else {
    dbInsert('project_config', { key: 'projectName', value: projectName });
    dbInsert('project_config', { key: 'projectDescription', value: projectDescription });
  }
  console.log('   ✓ 已保存');

  // ── 5️⃣ 项目上下文导入 ──
  await importProjectContext(workspace);

  // ── 6️⃣ 同步角色配置（分析前需先有 .opencode/agents/） ──
  console.log('\n6️⃣  同步角色配置');
  syncAgents(workspace);
  deployTools(workspace);
  console.log('   ✓ 完成');

  // ── 6.5 检查必要的 MCP 服务 ──
  console.log('\n   检查 MCP 服务');
  const mcpResult = ensureRequiredMcps();
  for (const name of mcpResult.alreadyExists) {
    console.log(`   ✓ ${name} 已就绪`);
  }
  for (const name of mcpResult.installed) {
    console.log(`   + ${name} 已自动添加到 opencode 配置`);
  }

  // ── 7️⃣ 工作空间分析 ──
  const subProjects = detectSubProjects(workspace);
  const isMonorepo = subProjects.length > 0;
  console.log('\n7️⃣  工作空间分析（AI 扫描项目结构）');
  if (isMonorepo) {
    console.log(`   检测到 Monorepo，子项目: ${subProjects.join(', ')}`);
  }
  let overview = '';
  let serverHandle: Awaited<ReturnType<typeof startOpencodeServer>> | null = null;
  if (!detectExistingCode(workspace)) {
    console.log('   空目录，跳过');
  } else
    try {
      serverHandle = await startOpencodeServer(workspace);
      const { client } = serverHandle;

      const session = await client.session.create({ body: { title: 'wa-onboarding-analyst' } });
      const sessionId = session.data!.id;

      const docsDir = path.join(workspace, '.win-agent', 'docs');
      if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

      // Helper: send prompt and extract text
      const generateDoc = async (prompt: string): Promise<string> => {
        const result = await client.session.prompt({
          path: { id: sessionId },
          body: {
            agent: 'PM',
            parts: [{ type: 'text', text: prompt }],
          },
        });
        const textParts = result.data?.parts?.filter(
          (p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text'
        );
        return cleanOverviewOutput(textParts?.map((p) => p.text).join('\n') ?? '');
      };

      // 7a. overview.md
      console.log('   → 生成项目概览 (overview.md)...');
      overview = await generateDoc(buildWorkspaceAnalysisPrompt(subProjects));
      fs.writeFileSync(
        path.join(docsDir, 'overview.md'),
        `# 项目概览\n\n_由 \`win-agent onboard\` 自动生成_\n\n${overview}`,
        'utf-8'
      );
      console.log('   ✓ 已写入 .win-agent/docs/overview.md');

      // 7b. development.md
      console.log('   → 生成开发流程规范 (development.md)...');
      const devContent = await generateDoc(buildDevelopmentDocPrompt(subProjects));
      fs.writeFileSync(
        path.join(docsDir, 'development.md'),
        `# 开发流程规范\n\n_由 \`win-agent onboard\` 自动生成，请审阅并补充标记为 TODO 的部分_\n\n${devContent}`,
        'utf-8'
      );
      console.log('   ✓ 已写入 .win-agent/docs/development.md');

      // 7c. validation.md
      console.log('   → 生成自测与验收规范 (validation.md)...');
      const valContent = await generateDoc(buildValidationDocPrompt(subProjects));
      fs.writeFileSync(
        path.join(docsDir, 'validation.md'),
        `# 自测与验收规范\n\n_由 \`win-agent onboard\` 自动生成，请审阅并补充标记为 TODO 的部分_\n\n${valContent}`,
        'utf-8'
      );
      console.log('   ✓ 已写入 .win-agent/docs/validation.md');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'INSTALL_FAILED') {
        throw err;
      }
      console.log(`   ⚠️  工作空间分析失败，跳过: ${err}`);
    } finally {
      if (serverHandle?.owned) {
        serverHandle.close();
        removeServerInfo(workspace);
      }
    }

  // ── 8️⃣ 注入项目上下文到角色文件 ──
  console.log('\n8️⃣  更新角色文件');
  injectProjectContext(workspace, projectName, projectDescription);
  syncAgents(workspace); // re-sync after injection
  console.log('   ✓ 完成');

  // ── 9️⃣ 确保 docs 规则文件存在 ──
  ensureDocsFiles(workspace, subProjects);

  // ── 完成 ──
  // Snapshot role file mtimes so `start` can detect user edits
  snapshotRoleMtimes(workspace);
  snapshotDocsMtimes(workspace);

  if (alreadyDone.length === 0) {
    dbInsert('project_config', { key: 'onboarding_completed', value: 'true' });
  }
  closeDb();

  console.log('\n✅ Onboarding 完成');
  console.log(`   项目: ${projectName}`);
  if (overview) console.log('   概览: .win-agent/docs/overview.md');
  console.log('   角色: .win-agent/roles/  （可直接编辑，重启后对 PM 生效）');
  console.log('\n提示：如需额外 MCP 工具，请在启动前通过 opencode mcp add 配置');
  console.log('就绪后执行：npx win-agent start');
}

// ─── 项目上下文导入 ───────────────────────────────────────────────────────────

async function importProjectContext(workspace: string) {
  console.log('\n5️⃣  项目上下文导入');

  let knowledgeCount = 0;

  const hasCode = detectExistingCode(workspace);
  if (!hasCode) {
    console.log('   a) 空目录，跳过代码扫描');
  }

  const doImport = await confirm({
    message: '导入参考资料（设计稿、PRD、API 文档等）？',
    default: false,
  });
  if (doImport) {
    const refDir = await input({ message: '资料目录路径' });
    const resolved = path.resolve(refDir.trim());
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      knowledgeCount += await importReferenceDir(resolved, workspace);
    } else {
      console.log(`   ⚠️  目录不存在: ${resolved}`);
    }
  }

  const doConstraints = await confirm({ message: '声明技术约束？', default: false });
  if (doConstraints) {
    const deployEnv = await input({ message: '目标部署环境 (留空跳过)', default: '' });
    const requiredTech = await input({ message: '必须使用的技术/框架 (留空跳过)', default: '' });
    const forbiddenTech = await input({ message: '禁止使用的技术/框架 (留空跳过)', default: '' });
    const otherConstraints = await input({ message: '其他约束 (留空跳过)', default: '' });

    const constraints: Record<string, string> = {};
    if (deployEnv) constraints.deployEnv = deployEnv;
    if (requiredTech) constraints.requiredTech = requiredTech;
    if (forbiddenTech) constraints.forbiddenTech = forbiddenTech;
    if (otherConstraints) constraints.other = otherConstraints;

    if (Object.keys(constraints).length > 0) {
      dbInsert('project_config', { key: 'constraints', value: JSON.stringify(constraints) });
      const parts: string[] = [];
      if (deployEnv) parts.push(`- 部署环境: ${deployEnv}`);
      if (requiredTech) parts.push(`- 必须使用: ${requiredTech}`);
      if (forbiddenTech) parts.push(`- 禁止使用: ${forbiddenTech}`);
      if (otherConstraints) parts.push(`- 其他约束: ${otherConstraints}`);
      await insertKnowledge({
        title: '技术约束',
        content: parts.join('\n'),
        category: 'convention',
        tags: 'constraints',
        created_by: 'system',
      });
      knowledgeCount++;
      console.log(`   ✓ ${Object.keys(constraints).length} 条约束已记录`);
    }
  }

  if (knowledgeCount > 0) {
    console.log(`   📦 知识库: ${knowledgeCount} 条记录已写入`);
  } else {
    console.log('   📦 完成（无新记录）');
  }
}

async function importReferenceDir(refDir: string, workspace: string): Promise<number> {
  const TEXT_EXTS = new Set(['.md', '.txt', '.rst', '.html', '.json', '.yaml', '.yml', '.xml']);
  const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);
  const attachDir = path.join(workspace, '.win-agent', 'attachments');

  let count = 0;
  for (const entry of fs.readdirSync(refDir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const filePath = path.join(refDir, entry.name);
    const ext = path.extname(entry.name).toLowerCase();

    if (TEXT_EXTS.has(ext)) {
      await insertKnowledge({
        title: entry.name,
        content: fs.readFileSync(filePath, 'utf-8'),
        category: 'reference',
        tags: `imported,${ext.slice(1)}`,
        created_by: 'system',
      });
      console.log(`   ✓ 导入文本: ${entry.name}`);
    } else {
      fs.copyFileSync(filePath, path.join(attachDir, entry.name));
      await insertKnowledge({
        title: entry.name,
        content: `[${IMAGE_EXTS.has(ext) ? '图片' : '附件'}] .win-agent/attachments/${entry.name}`,
        category: 'reference',
        tags: `imported,${IMAGE_EXTS.has(ext) ? 'image,' : 'attachment,'}${ext.slice(1)}`,
        created_by: 'system',
      });
      console.log(`   ✓ 导入${IMAGE_EXTS.has(ext) ? '图片' : '附件'}: ${entry.name}`);
    }
    count++;
  }
  return count;
}

// ─── Mtime 快照 ───────────────────────────────────────────────────────────────

export function snapshotRoleMtimes(workspace: string): void {
  const rolesDir = path.join(workspace, '.win-agent', 'roles');
  if (!fs.existsSync(rolesDir)) return;
  const snapshot: Record<string, number> = {};
  for (const file of fs.readdirSync(rolesDir)) {
    if (!file.endsWith('.md')) continue;
    snapshot[file] = fs.statSync(path.join(rolesDir, file)).mtimeMs;
  }
  const existing = dbSelect<{ key: string; value: string }>('project_config', {
    key: 'role_mtimes_snapshot',
  });
  if (existing.length > 0) {
    dbUpdate(
      'project_config',
      { key: 'role_mtimes_snapshot' },
      { value: JSON.stringify(snapshot) }
    );
  } else {
    dbInsert('project_config', { key: 'role_mtimes_snapshot', value: JSON.stringify(snapshot) });
  }

  // Snapshot overview.md mtime
  const overviewPath = path.join(workspace, '.win-agent', 'docs', 'overview.md');
  if (fs.existsSync(overviewPath)) {
    const mtime = String(fs.statSync(overviewPath).mtimeMs);
    const existingOv = dbSelect<{ key: string; value: string }>('project_config', {
      key: 'overview_mtime_snapshot',
    });
    if (existingOv.length > 0) {
      dbUpdate('project_config', { key: 'overview_mtime_snapshot' }, { value: mtime });
    } else {
      dbInsert('project_config', { key: 'overview_mtime_snapshot', value: mtime });
    }
  }
}

// ─── Docs 规则文件 ───────────────────────────────────────────────────────────

function buildDocsSkeleton(subProjects: string[]): Record<string, string> {
  const isMonorepo = subProjects.length > 0;

  const perProjectDev = isMonorepo
    ? '\n' +
      subProjects
        .map(
          (p) => `### ${p}

> ⚠️ **TODO**: 请补充 ${p} 的开发命令和技术栈最佳实践
`
        )
        .join('\n')
    : '';

  const perProjectVal = isMonorepo
    ? '\n' +
      subProjects
        .map(
          (p) => `### ${p}

#### 自测要求

> ⚠️ **TODO**: 请补充 ${p} 的自测要求

#### E2E 验证

> ⚠️ **TODO**: 请补充 ${p} 的 E2E 验证要求
`
        )
        .join('\n')
    : '';

  return {
    'development.md': `# 开发流程规范

_AI 分析未能运行，以下为模板骨架，请补充标记为 TODO 的部分_

## 技术栈

> ⚠️ **TODO**: 请补充项目的核心技术栈（语言、框架、运行时、包管理器等）

## 开发命令

> ⚠️ **TODO**: 请补充安装依赖、开发启动、构建、lint、测试等命令

## 开发流程

> ⚠️ **TODO**: 请补充开发任务的标准执行步骤

## 技术栈最佳实践

> ⚠️ **TODO**: 请补充基于项目技术栈的开发最佳实践要点

## 分支与提交规范

> ⚠️ **TODO**: 请简要补充分支策略和提交规范
${perProjectDev}`,
    'validation.md': `# 自测与验收规范

_AI 分析未能运行，以下为模板骨架，请补充标记为 TODO 的部分_

## 自测要求

> ⚠️ **TODO**: 请补充单元测试框架、运行命令和覆盖率要求

## E2E 验证

> ⚠️ **TODO**: 请补充 E2E 测试框架和运行命令

## 回归测试

> ⚠️ **TODO**: 请补充回归测试策略

## 验收标准

> ⚠️ **TODO**: 请补充功能验收标准
${perProjectVal}`,
  };
}

function ensureDocsFiles(workspace: string, subProjects: string[]): void {
  const docsDir = path.join(workspace, '.win-agent', 'docs');
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }
  const skeleton = buildDocsSkeleton(subProjects);
  for (const [filename, content] of Object.entries(skeleton)) {
    const filePath = path.join(docsDir, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content, 'utf-8');
      console.log(`   ✓ 已创建 .win-agent/docs/${filename}`);
    }
  }
}

export function snapshotDocsMtimes(workspace: string): void {
  const docsDir = path.join(workspace, '.win-agent', 'docs');
  if (!fs.existsSync(docsDir)) return;

  const targets = ['development.md', 'validation.md'];
  const snapshot: Record<string, number> = {};
  for (const file of targets) {
    const filePath = path.join(docsDir, file);
    if (fs.existsSync(filePath)) {
      snapshot[file] = fs.statSync(filePath).mtimeMs;
    }
  }
  if (Object.keys(snapshot).length === 0) return;

  const existing = dbSelect<{ key: string; value: string }>('project_config', {
    key: 'docs_mtimes_snapshot',
  });
  if (existing.length > 0) {
    dbUpdate('project_config', { key: 'docs_mtimes_snapshot' }, { value: JSON.stringify(snapshot) });
  } else {
    dbInsert('project_config', { key: 'docs_mtimes_snapshot', value: JSON.stringify(snapshot) });
  }
}

// ─── 角色文件上下文注入 ────────────────────────────────────────────────────────

function injectProjectContext(workspace: string, projectName: string, projectDescription: string) {
  const rolesDir = path.join(workspace, '.win-agent', 'roles');
  if (!fs.existsSync(rolesDir)) return;

  const block = [
    '<!-- win-agent:project-context -->',
    '## 项目背景',
    `- **项目名称**: ${projectName}`,
    `- **项目描述**: ${projectDescription}`,
    '- **技术概览**: 详见 `.win-agent/docs/overview.md`',
    '<!-- /win-agent:project-context -->',
    '',
  ].join('\n');

  const sentinel =
    /<!-- win-agent:project-context -->[\s\S]*?<!-- \/win-agent:project-context -->\n?/;

  for (const file of fs.readdirSync(rolesDir)) {
    if (!file.endsWith('.md')) continue;
    const filePath = path.join(rolesDir, file);
    let content = fs.readFileSync(filePath, 'utf-8');
    if (sentinel.test(content)) {
      content = content.replace(sentinel, block);
    } else {
      const firstNewline = content.indexOf('\n') + 1;
      content = content.slice(0, firstNewline) + '\n' + block + content.slice(firstNewline);
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`   ✓ ${file}`);
  }
}
