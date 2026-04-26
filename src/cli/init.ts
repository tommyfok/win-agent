import fs from 'node:fs';
import path from 'node:path';
import { input, confirm, select } from '@inquirer/prompts';
import { runEnvCheck } from './check.js';
import { initWorkspace, detectExistingCode, detectSubProjects } from '../workspace/init.js';
import { openDb, closeDb, getDb } from '../db/connection.js';
import { select as dbSelect, insert as dbInsert, update as dbUpdate } from '../db/repository.js';
import { syncAgents, deployTools, ensureRequiredMcps } from '../workspace/sync-agents.js';
import { insertKnowledge } from '../embedding/knowledge.js';
import { getEmbeddingDimension } from '../embedding/index.js';
import { setEmbeddingDimension } from '../db/schema.js';
import { getDbPath } from '../config/index.js';
import { startOpencodeServer, removeServerInfo } from '../engine/opencode-server.js';
import { Role } from '../engine/role-manager.js';
import { checkAndInstallSkills } from './skills.js';
import { AGENTS_MD_FILENAME } from './constants.js';

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

/**
 * Check whether a docs file is a skeleton/placeholder (not yet filled with real content).
 * Skeleton files contain TODO markers, or greenfield placeholder text like "待脚手架任务完成后补充".
 */
function isSkeletonOrPlaceholder(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return true;
  const content = fs.readFileSync(filePath, 'utf-8');
  // Greenfield placeholder
  if (content.includes('待脚手架任务完成后补充')) return true;
  // Skeleton with TODO markers
  if (TODO_MARKER_REGEX.test(content)) return true;
  // AI analysis failure skeleton
  if (content.includes('以下为模板骨架')) return true;
  return false;
}

export function buildWorkspaceAnalysisPrompt(subProjects: string[]): string {
  const isMonorepo = subProjects.length > 0;
  const subProjectList = subProjects.map((p) => `  - ${p}`).join('\n');

  const monorepoSection = isMonorepo
    ? `**重要：这是一个 Monorepo 项目，包含以下子项目：**
${subProjectList}

你必须逐个进入每个子项目目录，读取其 package.json / Makefile / 配置文件等，分析其独立的技术栈。不要只看根目录。`
    : '';

  const chaptersSection = isMonorepo
    ? `请直接输出 Markdown 格式的概览文档，必须包含以下章节：

**重要：本文档的定位是"项目认知地图"，帮助 Agent 理解项目全貌和架构关系。开发命令、代码检查、E2E 验收等操作细节由 development.md 和 validation.md 负责，本文档不要包含这些内容。**

## 整体架构
  描述项目整体目标、各子项目之间的关系（调用关系、数据流向），建议用 ASCII 架构图展示。

## 子项目明细
  对每个子项目分别输出以下内容（使用三级标题 ### 子项目名）：
  ### <子项目名>
  - **定位**：一句话说明这个子项目解决什么问题、服务谁
  - **技术栈**：语言/框架/关键依赖（如 ORM、UI 库、队列等）
  - **核心模块**：主要功能划分（如"相册管理、媒体处理、支付"）
  不要列出开发命令、目录结构等操作细节（这些在 development.md 中）。

## 共享基础设施
  跨子项目的共享资源和约定，包括：
  - 共享的数据库、缓存、存储服务
  - 共享的认证/鉴权机制
  - 子项目间的依赖关系（如哪些前端调用哪个后端）`
    : `请直接输出 Markdown 格式的概览文档，必须包含以下章节：

**重要：本文档的定位是"项目认知地图"，帮助 Agent 理解项目全貌。开发命令、代码检查、E2E 验收等操作细节由 development.md 和 validation.md 负责，本文档不要包含这些内容。**

## 项目定位
  一段话说明项目解决什么问题、服务谁。
## 技术栈
  列出主要语言/框架/关键依赖。
## 核心模块
  主要功能划分和模块职责。
## 架构要点
  关键的架构决策、外部依赖（数据库、缓存、第三方服务等）。`;

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

Step 4 — read 读取 Step 2 中找到的配置文件，提取技术栈信息

重点了解：
1. 项目类型和主要技术栈
2. 主要模块/功能划分
3. 子项目之间的关系和依赖
4. 外部依赖（数据库、缓存、存储、第三方服务）
${monorepoSection}

${chaptersSection}

严格要求：直接以 Markdown 正文开头（即以 ## 标题开头），禁止输出任何过渡性语句、思考过程或额外解释（如"现在我来生成文档"、"我已经分析完毕"等）。`;
}

export function buildDevelopmentDocPrompt(subProjects: string[]): string {
  const isMonorepo = subProjects.length > 0;
  const subProjectList = subProjects.map((p) => `  - ${p}`).join('\n');

  const monorepoNote = isMonorepo
    ? `\n**Monorepo 项目，子项目：**
${subProjectList}
在每个章节下使用 ### 子项目名 分别说明。`
    : '';

  return `分析当前工作空间，生成面向 AI Agent 的开发指南。内容必须简洁、可直接执行。

**重要：本文档只包含具体的执行步骤。项目背景、技术栈、架构关系等宏观信息请参考 overview.md，不要在本文档中重复。**

扫描步骤（禁止扫描 \`.\` 开头的目录）：
  glob("[!.]**/package.json")
  glob("[!.]**/go.mod")
  glob("[!.]**/Cargo.toml")
  glob("[!.]**/pyproject.toml")
  glob("[!.]**/pom.xml")
  glob("[!.]**/.eslintrc*")
  glob("[!.]**/biome.json")
  glob("[!.]**/docker-compose*")
  glob("[!.]**/tsconfig.json")
  glob("[!.]**/jest.config*")
  glob("[!.]**/vitest.config*")
  glob("[!.]**/pytest.ini")
  glob("[!.]**/setup.cfg")  （查找 [tool:pytest] 段）
  也读取根目录 README.md（如果存在）
  找 2-3 个已有测试文件，read 其内容以了解测试编写模式
 ${monorepoNote}

输出以下章节：

## Phase 1: 准备工作

列出从零开始到可以开发需要的所有命令和前置依赖，例如：
\`\`\`bash
pnpm install
\`\`\`
包括但不限于：包管理器安装、依赖安装、环境变量配置（列出需要的 .env 变量名）、数据库初始化、Docker 服务启动等。
优先检查是否有 docker-compose.dev 相关配置，如果有则使用 docker compose 启动开发环境。

## Phase 2: 启动开发环境

基于 package.json / Makefile 等实际命令，**只列出开发过程中使用的命令**：
\`\`\`bash
pnpm dev          # 启动开发服务器
pnpm build        # 构建
pnpm db:generate  # 生成数据库迁移（如有）
\`\`\`
**不要列出 lint、test 等验证类命令**（这些由 validation.md 管理）。

## Phase 3: 按照以下要求实现功能

根据项目实际技术栈，给出 Agent 编码时必须遵循的要求。每条 1 句话，分为两层：
1. **通用规则**，适用于所有子项目的规则，包括：
   - 代码规范（根据 eslint/prettier/biome 配置推断）
   - 提交规范
   - 技术栈最佳实践（如有 \`npx skills find\` 可用则查询，否则根据配置文件推断）
2. **子项目特有规则**（仅 Monorepo 需要）：每个子项目只列与通用规则不同的差异点，不重复通用规则的内容

## Phase 4: 编写测试代码

基于扫描到的测试配置和已有测试文件，给出 Agent 编写测试时必须遵循的规范：

1. **测试框架与配置**：使用什么测试框架（jest/vitest/pytest/go test 等），是否有全局 setup 文件
2. **文件位置与命名**：测试文件放在哪里（\`__tests__/\` 目录、同级 \`*.test.ts\`、还是 \`tests/\` 顶层目录），命名规范是什么
3. **编写模式**：根据已有测试代码总结项目实际使用的模式，包括：
   - Mock 策略：项目是如何 mock 外部依赖的（如数据库、API 调用）？是否有统一的 mock 工具或 helper？
   - 测试数据：是否使用 fixture、factory、还是内联构造？
   - 常用的断言风格和测试结构（describe/it 嵌套方式等）
4. **覆盖要求**：新增功能是否必须附带单元测试？是否有覆盖率门槛？

如果项目尚无测试，明确标注并给出基于当前技术栈的推荐测试方案。

## 重要规则：TODO 标记
无法确定的内容用此格式标记：
> ⚠️ **TODO**: 说明需要补充什么

直接以 ## 开头，禁止输出过渡性语句。`;
}

export function buildValidationDocPrompt(subProjects: string[]): string {
  const isMonorepo = subProjects.length > 0;
  const subProjectList = subProjects.map((p) => `  - ${p}`).join('\n');

  const monorepoNote = isMonorepo
    ? `\n**Monorepo 项目，子项目：**
${subProjectList}
在每个章节下使用 ### 子项目名 分别说明。`
    : '';

  return `分析当前工作空间，生成面向 AI Agent 的验收规范文档。内容必须简洁、可直接执行。

扫描步骤（禁止扫描 \`.\` 开头的目录）：
  glob("[!.]**/jest.config*")
  glob("[!.]**/vitest.config*")
  glob("[!.]**/playwright.config*")
  glob("[!.]**/cypress.config*")
  glob("[!.]**/pytest.ini")
  glob("[!.]**/package.json")
  read 上述找到的配置文件
${monorepoNote}

输出以下章节：

## Phase 1: 代码检查

列出 Agent 提交代码前**必须全部通过**的检查命令。任一命令失败则不得继续，必须先修复。

根据项目实际情况调查并列出（必须经过有现实依据的调查，给出实际、真实的命令）。**按执行速度从快到慢排列**（轻量检查先跑，尽早发现问题），比如：
\`\`\`bash
pnpm lint          # 1. 代码规范检查（最快，秒级）
pnpm build         # 2. 编译检查（较快，检测类型错误）
pnpm test          # 3. 单元测试（可能较慢）
\`\`\`

## Phase 2: E2E 验收

**重要前提：验收执行者是 AI Agent，不是人类。** Agent 只能通过 MCP 工具和命令行操作，无法手动操作 GUI。因此：
- **禁止**生成需要人类手动操作的步骤（如"打开微信开发者工具"、"在浏览器中访问"、"手机真机调试"等）
- **必须**给出 Agent 可自主执行的 MCP 工具调用或命令行操作

根据项目类型，**必须**使用以下对应的 MCP 工具进行验收：

- **Web 前端/全栈项目**：**必须使用 Playwright MCP** 启动浏览器、访问页面、操作元素、截图验证。列出启动命令和 Playwright MCP 验收步骤。
- **API/后端服务**：使用 curl 调用关键接口，验证返回正确。列出启动命令和示例请求。
- **小程序项目**：**必须使用 miniapp-mcp** 进行端到端测试，包括启动模拟器、页面导航、元素交互等。
- **CLI/库项目**：执行主要命令或导入模块，验证核心功能。

只写与本项目匹配的类型，给出 Agent 可直接执行的具体验收步骤和命令。

**启动/关闭对称（强制）**：
只要步骤中**启动了任何常驻后台进程**（dev server / API server / 预览服务等），验收章节必须：

1. 启动时用如下模式记录 PID，便于后续清理：
   \`\`\`bash
   # 示例（按项目实际命令替换 CMD）
   CMD & echo $! >> .win-agent/.dev-pids
   \`\`\`
2. 在本章结尾给出**清理步骤**（与启动对称），模板：
   \`\`\`bash
   if [ -f .win-agent/.dev-pids ]; then
     while read -r P; do kill "$P" 2>/dev/null || true; done < .win-agent/.dev-pids
     sleep 2
     while read -r P; do kill -0 "$P" 2>/dev/null && kill -9 "$P" 2>/dev/null || true; done < .win-agent/.dev-pids
     rm -f .win-agent/.dev-pids
   fi
   \`\`\`
3. **禁止**使用 \`pkill -f '<模糊关键词>'\`、\`killall node\` 等会误伤用户其他进程的命令。
4. Playwright MCP 内置 webServer 或由 MCP 自行管理的浏览器不需要写入 \`.dev-pids\`。

## 重要规则：TODO 标记
无法确定的内容用此格式标记：
> ⚠️ **TODO**: 说明需要补充什么

直接以 ## 开头，禁止输出过渡性语句。`;
}

export async function initCommand() {
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

  // ── 2️⃣ 幂等检查（在创建工作空间之前） ──
  const dbPath = getDbPath(workspace);
  let alreadyDone: { key: string; value: string }[] = [];
  if (fs.existsSync(dbPath)) {
    try {
      getDb();
    } catch {
      openDb(dbPath);
    }
    alreadyDone = dbSelect<{ key: string; value: string }>('project_config', {
      key: 'onboarding_completed',
    });
    if (alreadyDone.length > 0) {
      const rerun = await confirm({ message: '初始化已完成过，是否重新运行？', default: false });
      if (!rerun) {
        console.log('   已跳过');
        closeDb();
        return;
      }
    }
    closeDb();
  }

  // ── 3️⃣ 工作空间初始化 ──
  console.log('\n3️⃣  工作空间初始化');
  const initResult = initWorkspace(workspace);
  if (initResult.created) {
    console.log('   ✓ 工作空间已创建');
  } else {
    console.log('   ✓ 工作空间已存在');
  }

  try {
    getDb();
  } catch {
    openDb(dbPath);
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

  // ── 5️⃣ 项目模式检测 ──
  const hasCode = detectExistingCode(workspace);
  let projectMode: 'greenfield' | 'pending' | 'existing' = 'existing';
  if (!hasCode) {
    console.log('\n   检测到空目录');
    projectMode = await select({
      message: '选择项目模式',
      choices: [
        { name: '从零开始（0-to-1）—— 我要创建一个新项目', value: 'greenfield' as const },
        { name: '稍后放入代码 —— 代码就绪后重新 init', value: 'pending' as const },
      ],
    });
    const existingMode = dbSelect<{ key: string; value: string }>('project_config', {
      key: 'project_mode',
    });
    if (existingMode.length > 0) {
      dbUpdate('project_config', { key: 'project_mode' }, { value: projectMode });
    } else {
      dbInsert('project_config', { key: 'project_mode', value: projectMode });
    }
    const modeLabel = projectMode === 'greenfield' ? '从零开始' : '稍后放入代码';
    console.log(`   ✓ 项目模式: ${modeLabel}`);
  }

  // ── 6️⃣ 项目上下文导入 ──
  await importProjectContext(workspace);

  // ── 7️⃣ 验证角色配置 ──
  console.log('\n7️⃣  验证角色配置');
  const validated = syncAgents(workspace);
  console.log(`   ✓ ${validated.length} 个角色已验证`);
  deployTools(workspace);
  console.log('   ✓ 数据库工具已部署');

  // ── 7.5 检查必要的 MCP 服务 ──
  console.log('\n   检查 MCP 服务');
  const mcpResult = ensureRequiredMcps();
  for (const name of mcpResult.alreadyExists) {
    console.log(`   ✓ ${name} 已就绪`);
  }
  for (const name of mcpResult.installed) {
    console.log(`   + ${name} 已自动添加到 opencode 配置`);
  }

  // ── 8️⃣ 工作空间分析 ──
  const subProjects = detectSubProjects(workspace);
  const isMonorepo = subProjects.length > 0;
  console.log('\n8️⃣  工作空间分析（AI 扫描项目结构）');
  if (isMonorepo) {
    console.log(`   检测到 Monorepo，子项目: ${subProjects.join(', ')}`);
  }
  let overview = '';
  let serverHandle: Awaited<ReturnType<typeof startOpencodeServer>> | null = null;
  if (projectMode === 'greenfield' || projectMode === 'pending') {
    const label = projectMode === 'greenfield' ? '0-to-1 模式' : '稍后放入代码模式';
    console.log(`   ${label}，跳过 AI 分析，生成占位文档`);
    const docsDir = path.join(workspace, '.win-agent', 'docs');
    if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
    const placeholderDocs =
      projectMode === 'greenfield' ? buildGreenfieldDocs() : buildPendingDocs();
    for (const [filename, content] of Object.entries(placeholderDocs)) {
      const filePath = path.join(docsDir, filename);
      fs.writeFileSync(filePath, content, 'utf-8');
      console.log(`   ✓ 已创建 .win-agent/docs/${filename}`);
    }
    if (projectMode === 'pending') {
      console.log('\n   提示：代码就绪后请重新运行 npx win-agent init');
    }
  } else if (!detectExistingCode(workspace)) {
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
        `# 项目概览\n\n_由 \`win-agent init\` 自动生成_\n\n${overview}`,
        'utf-8'
      );
      console.log('   ✓ 已写入 .win-agent/docs/overview.md');

      // 7a-2. Generate root AGENTS.md for agent working rules
      console.log(`   → 生成 Agent 工作规范 (${AGENTS_MD_FILENAME})...`);
      const agentMdContent = buildAgentsMd(projectName, projectDescription, overview);
      fs.writeFileSync(path.join(workspace, AGENTS_MD_FILENAME), agentMdContent, 'utf-8');
      console.log(`   ✓ 已写入 ${AGENTS_MD_FILENAME}（根目录，Agent 工作规范）`);

      // 7b. development.md
      const devPath = path.join(docsDir, 'development.md');
      let skipDev = false;
      if (fs.existsSync(devPath) && !isSkeletonOrPlaceholder(devPath)) {
        skipDev = !(await confirm({
          message: 'development.md 已包含实际内容（可能由 DEV 更新），是否覆盖？',
          default: false,
        }));
      }
      if (!skipDev) {
        console.log('   → 生成开发指南 (development.md)...');
        const devContent = await generateDoc(buildDevelopmentDocPrompt(subProjects));
        fs.writeFileSync(
          devPath,
          `# 开发指南\n\n_由 \`win-agent init\` 自动生成，请审阅并补充标记为 TODO 的部分_\n\n${devContent}`,
          'utf-8'
        );
        console.log('   ✓ 已写入 .win-agent/docs/development.md');
      } else {
        console.log('   ⏭ 保留已有 development.md');
      }

      // 7c. validation.md
      const valPath = path.join(docsDir, 'validation.md');
      let skipVal = false;
      if (fs.existsSync(valPath) && !isSkeletonOrPlaceholder(valPath)) {
        skipVal = !(await confirm({
          message: 'validation.md 已包含实际内容（可能由 DEV 更新），是否覆盖？',
          default: false,
        }));
      }
      if (!skipVal) {
        console.log('   → 生成验收规范 (validation.md)...');
        const valContent = await generateDoc(buildValidationDocPrompt(subProjects));
        fs.writeFileSync(
          valPath,
          `# 验收规范\n\n_由 \`win-agent init\` 自动生成，请审阅并补充标记为 TODO 的部分_\n\n${valContent}`,
          'utf-8'
        );
        console.log('   ✓ 已写入 .win-agent/docs/validation.md');
      } else {
        console.log('   ⏭ 保留已有 validation.md');
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'INSTALL_FAILED') {
        throw err;
      }
      console.log(`   ⚠️  工作空间分析失败，跳过: ${err}`);
    }
  // NOTE: serverHandle is kept alive for skills check below, closed after init completes

  // ── 9️⃣ 注入项目上下文到角色文件 ──
  console.log('\n9️⃣  更新角色文件');
  injectProjectContext(workspace, projectName, projectDescription);
  syncAgents(workspace); // re-sync after injection
  console.log('   ✓ 完成');

  // ── 🔟 确保 docs 规则文件存在 ──
  ensureDocsFiles(workspace, subProjects);

  // ── 完成 ──
  // Snapshot role file mtimes so `start` can detect user edits
  snapshotRoleMtimes(workspace);
  // greenfield/pending: only snapshot role files, skip docs (they are placeholders)
  if (projectMode === 'existing') {
    snapshotDocsMtimes(workspace);
  }

  if (alreadyDone.length === 0) {
    dbInsert('project_config', { key: 'onboarding_completed', value: 'true' });
  }
  closeDb();

  // ── Skills 推荐 ──
  if (serverHandle) {
    console.log('\n   Skills 推荐...');
    try {
      await checkAndInstallSkills(workspace, serverHandle.client);
    } catch {
      console.log('   ⚠️  Skills 推荐跳过');
    } finally {
      if (serverHandle.owned) {
        serverHandle.close();
        removeServerInfo(workspace);
      }
    }
  }

  console.log('\n✅ 初始化完成');
  console.log(`   项目: ${projectName}`);
  if (overview) console.log('   概览: .win-agent/docs/overview.md');
  console.log('   角色: .win-agent/roles/  （可直接编辑，重启后对 PM 生效）');
  console.log('\n提示：如需额外 MCP 工具，请在启动前通过 opencode mcp add 配置');
  console.log('就绪后执行：npx win-agent start');
}

// ─── 项目上下文导入 ───────────────────────────────────────────────────────────

async function importProjectContext(workspace: string) {
  console.log('\n6️⃣  项目上下文导入');

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
        created_by: Role.SYS,
      });
      knowledgeCount++;

      console.log(
        `   ✓ ${Object.keys(constraints).length} 条约束已记录（project_config + knowledge）`
      );
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
        created_by: Role.SYS,
      });
      console.log(`   ✓ 导入文本: ${entry.name}`);
    } else {
      fs.copyFileSync(filePath, path.join(attachDir, entry.name));
      await insertKnowledge({
        title: entry.name,
        content: `[${IMAGE_EXTS.has(ext) ? '图片' : '附件'}] .win-agent/attachments/${entry.name}`,
        category: 'reference',
        tags: `imported,${IMAGE_EXTS.has(ext) ? 'image,' : 'attachment,'}${ext.slice(1)}`,
        created_by: Role.SYS,
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
    // Skip role auxiliary files (e.g. PM-reference.md, DEV-reference.md) — not user-editable
    if (/^(PM|DEV)-/i.test(file)) continue;
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

function buildGreenfieldDocs(): Record<string, string> {
  return {
    'overview.md': `# 项目概览

_项目尚未创建，本文件将在脚手架搭建完成后由 PM 自动生成。_

待脚手架任务完成后补充。
`,
    'development.md': `# 开发指南

_项目尚未创建，本文件将在脚手架搭建完成后由 DEV 自动更新。_

## 环境准备
待脚手架任务完成后补充。

## 项目结构与约定
待脚手架任务完成后补充。

## 开发命令
待脚手架任务完成后补充。

## 编码要求
待脚手架任务完成后补充。

## 测试编写规范
待脚手架任务完成后补充。
`,
    'validation.md': `# 验收规范

_项目尚未创建，本文件将在脚手架搭建完成后由 DEV 自动更新。_

## 代码检查
待脚手架任务完成后补充。

## E2E 验收
待脚手架任务完成后补充。
`,
  };
}

function buildPendingDocs(): Record<string, string> {
  return {
    'overview.md': `# 项目概览

_代码尚未放入，本文件将在代码就绪后重新运行 init 时自动生成。_

待代码放入后重新运行 \`npx win-agent init\`。
`,
    'development.md': `# 开发指南

_代码尚未放入，本文件将在代码就绪后重新运行 init 时自动生成。_

## 环境准备
待代码放入后重新运行 \`npx win-agent init\`。

## 项目结构与约定
待代码放入后重新运行 \`npx win-agent init\`。

## 开发命令
待代码放入后重新运行 \`npx win-agent init\`。

## 编码要求
待代码放入后重新运行 \`npx win-agent init\`。

## 测试编写规范
待代码放入后重新运行 \`npx win-agent init\`。
`,
    'validation.md': `# 验收规范

_代码尚未放入，本文件将在代码就绪后重新运行 init 时自动生成。_

## 代码检查
待代码放入后重新运行 \`npx win-agent init\`。

## E2E 验收
待代码放入后重新运行 \`npx win-agent init\`。
`,
  };
}

function buildDocsSkeleton(subProjects: string[]): Record<string, string> {
  const isMonorepo = subProjects.length > 0;

  const perProjectDev = isMonorepo
    ? '\n' +
      subProjects
        .map(
          (p) => `### ${p}

> ⚠️ **TODO**: 请补充 ${p} 的环境准备和开发命令
`
        )
        .join('\n')
    : '';

  const perProjectVal = isMonorepo
    ? '\n' +
      subProjects
        .map(
          (p) => `### ${p}

> ⚠️ **TODO**: 请补充 ${p} 的检查命令和 E2E 验收方式
`
        )
        .join('\n')
    : '';

  return {
    'development.md': `# 开发指南

_AI 分析未能运行，以下为模板骨架，请补充标记为 TODO 的部分_

## 环境准备

> ⚠️ **TODO**: 请补充安装依赖和环境准备命令

## 项目结构与约定

> ⚠️ **TODO**: 请补充主要目录职责、新增文件放置规则、模块依赖方向

## 开发命令

> ⚠️ **TODO**: 请补充开发、构建等命令（lint/test 由 validation.md 管理）

## 编码要求

> ⚠️ **TODO**: 请补充代码规范和技术栈最佳实践要点

## 测试编写规范

> ⚠️ **TODO**: 请补充测试框架、文件位置与命名、编写模式（mock 策略/测试数据/断言风格）、覆盖要求
${perProjectDev}`,
    'validation.md': `# 验收规范

_AI 分析未能运行，以下为模板骨架，请补充标记为 TODO 的部分_

## 代码检查

> ⚠️ **TODO**: 请补充 lint、build、test 等检查命令

## E2E 验收

> ⚠️ **TODO**: 请补充端到端验收方式和命令
${perProjectVal}`,
  };
}

/** Archive doc files that DEV writes experience into */
const ARCHIVE_DOCS: Record<string, string> = {
  'known-issues.md': `# 已知问题

_DEV 在开发过程中遇到的技术问题及解决方案，自动追加。_
`,
  'dev-notes.md': `# 开发笔记

_DEV 在开发过程中发现的项目经验，自动追加。_
`,
  'efficiency-and-skills.md': `# 效率优化

_DEV 在开发过程中发现的效率瓶颈和优化方案，自动追加。_
`,
};

function ensureDocsFiles(workspace: string, subProjects: string[]): void {
  const docsDir = path.join(workspace, '.win-agent', 'docs');
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }
  // Ensure development.md / validation.md skeleton
  const skeleton = buildDocsSkeleton(subProjects);
  for (const [filename, content] of Object.entries(skeleton)) {
    const filePath = path.join(docsDir, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content, 'utf-8');
      console.log(`   ✓ 已创建 .win-agent/docs/${filename}`);
    }
  }
  // Ensure archive docs (known-issues, dev-notes, efficiency-and-skills)
  for (const [filename, content] of Object.entries(ARCHIVE_DOCS)) {
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
    dbUpdate(
      'project_config',
      { key: 'docs_mtimes_snapshot' },
      { value: JSON.stringify(snapshot) }
    );
  } else {
    dbInsert('project_config', { key: 'docs_mtimes_snapshot', value: JSON.stringify(snapshot) });
  }
}

// ─── AGENTS.md 生成 ─────────────────────────────────────────────────────────

/**
 * Build root AGENTS.md content from project info.
 * This file defines stable agent behavior and points to overview.md for
 * project background instead of duplicating the overview content.
 */
export function buildAgentsMd(
  projectName: string,
  projectDescription: string,
  overviewContent: string
): string {
  const overviewStatus = overviewContent.trim()
    ? '`.win-agent/docs/overview.md` 已生成，先阅读它来建立项目认知。'
    : '`.win-agent/docs/overview.md` 暂未生成或为空，如任务需要项目背景，请先补充该文档。';

  return `# AGENTS.md

_此文件由 \`win-agent\` 自动生成，定义 AI Agent 在本仓库中的工作规范。_

## 项目背景

- **项目名称**: ${projectName || '未命名项目'}
- **项目描述**: ${projectDescription || '暂无描述'}
- **技术概览**: ${overviewStatus}

## 启动流程

每次开始处理任务前，先按顺序完成以下步骤：

1. 阅读本文件，确认本仓库对 Agent 的工作约束。
2. 阅读 \`.win-agent/docs/overview.md\`，了解项目定位、技术栈、核心模块和架构要点。
3. 执行 \`git status\` 和 \`git log --oneline -10\`，确认当前工作区状态和近期变更。
4. 根据任务类型阅读相关源码、文档和已有测试，不要只依赖历史记忆或文件名猜测。

## 工作规范

- 优先遵循用户当前指令；如指令与本文件冲突，先向用户确认。
- 不要回滚、覆盖或整理与你当前任务无关的既有改动。
- 修改代码前先理解现有模式，尽量沿用项目已有架构、命名和工具链。
- 保持变更聚焦，只改动完成任务所必需的文件。
- 涉及用户可见行为、接口契约、数据结构或运维流程变化时，同步更新相关文档。

## 文件边界

- 根目录 \`AGENTS.md\` 负责 Agent 行为规范，不承载完整项目概览。
- \`.win-agent/docs/overview.md\` 负责项目认知地图，包括项目定位、技术栈、模块职责和架构要点。
- \`.win-agent/docs/development.md\` 负责开发命令、构建方式和本地调试流程。
- \`.win-agent/docs/validation.md\` 负责测试、验收和发布前检查流程。
- 除任务明确要求，或代码变更必须同步更新上述文档外，不要修改 \`.win-agent/\` 内部文件。

## 验证要求

- 完成代码修改后，运行与变更范围匹配的检查或测试。
- 如果无法运行验证，说明原因，并给出你已经完成的替代检查。
- 提交结果时，简要说明改动内容、验证命令和剩余风险。
`;
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
    if (!/^[A-Z].*\.md$/.test(file)) continue;
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
