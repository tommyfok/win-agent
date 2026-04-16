import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig, type WinAgentConfig } from '../config/index.js';
import { input, select } from '@inquirer/prompts';
import { fetchOpencodeModels } from './model.js';

/**
 * Run interactive environment check. Prompts for missing config items.
 * Config is stored in <cwd>/.win-agent/config.json.
 * Returns the validated config and workspace path.
 */
export async function runEnvCheck(): Promise<{ config: WinAgentConfig; workspace: string }> {
  const workspace = process.cwd();
  console.log('\n🔍 环境检查中...\n');
  console.log(`工作空间: ${workspace}`);

  const config = loadConfig(workspace);
  let changed = false;

  // 1. Provider/Model
  console.log('\n1. LLM Provider 配置');
  if (config.provider?.type && config.provider?.model) {
    console.log(
      `   ✓ 已配置 → ${config.provider.type} / ${config.provider.model}${config.provider.reasoning ? ' (推理模型)' : ''}`
    );
  } else {
    console.log('   → 获取可用 Provider 列表...');
    const providerMap = fetchOpencodeModels();

    if (!providerMap || providerMap.size === 0) {
      console.log('   ❌ 未检测到可用的 opencode Provider');
      console.log('   💡 请先运行 `opencode auth login` 配置认证信息');
      process.exit(1);
    }

    const providers = Array.from(providerMap.keys()).sort();
    console.log(`   ✓ 找到 ${providers.length} 个可用 Provider`);

    const selectedProvider = await select<string>({
      message: '请选择 Provider',
      choices: providers.map((p) => ({ value: p, name: p })),
    });

    const models = providerMap.get(selectedProvider)!;
    const selectedModel = await select<string>({
      message: `请选择 ${selectedProvider} 的模型`,
      choices: models.map((m) => ({ value: m, name: m })),
    });

    config.provider = {
      type: selectedProvider,
      apiKey: '',
      model: selectedModel,
    };
    changed = true;
    console.log(`   ✓ 已选择: ${selectedProvider} / ${selectedModel}`);
  }

  // 2. Embedding (only prompt if not already set — may have been set via preset)
  if (!config.embedding?.type) {
    console.log('\n2. Embedding 模型配置');
    const embType = await select({
      message: '请选择 Embedding Provider',
      choices: [
        { value: 'local', name: '本地模型 (bge-small-zh-v1.5, 无需 API)' },
        { value: 'openai', name: 'OpenAI (text-embedding-3-small)' },
      ],
    });

    if (embType === 'local') {
      config.embedding = { type: 'local', apiKey: '', model: 'Xenova/bge-small-zh-v1.5' };
    } else {
      const apiKey = await input({
        message: '请输入 Embedding API Key（留空则复用 Provider 的 Key）',
        default: '',
      });
      const model = await input({
        message: '请选择 Embedding 模型',
        default: 'text-embedding-3-small',
      });
      config.embedding = {
        type: embType,
        apiKey: apiKey || config.provider?.apiKey || '',
        model,
      };
    }
    changed = true;
  } else if (!changed) {
    console.log(`\n2. Embedding 模型配置`);
    console.log(`   ✓ 已配置 → ${config.embedding.type} / ${config.embedding.model || 'default'}`);
  }

  if (changed) {
    saveConfig(config, workspace);
  }

  console.log('\n✅ 环境检查通过');
  console.log(
    `   Provider: ${config.provider?.type} / ${config.provider?.model}${config.provider?.reasoning ? ' (推理模型)' : ''}`
  );
  console.log(`   Embedding: ${config.embedding?.type} / ${config.embedding?.model}`);

  // P1: docs/knowledge DB consistency lint
  await runConsistencyLint(workspace);

  // P4: display effective context rotation thresholds
  displayRotationThresholds(config);

  return { config, workspace };
}

/**
 * P1: Check consistency between knowledge DB entries and docs MD files.
 * Reports entries that exist only in DB or only in MD file.
 */
async function runConsistencyLint(workspace: string): Promise<void> {
  const winAgentDir = path.join(workspace, '.win-agent');
  const dbPath = path.join(winAgentDir, 'win-agent.db');
  if (!fs.existsSync(dbPath)) return;

  console.log('\n📋 双写一致性检查');

  const checks: Array<{ category: string; mdFile: string; label: string }> = [
    { category: 'issue', mdFile: 'known-issues.md', label: '已知问题' },
    { category: 'dev_note', mdFile: 'dev-notes.md', label: '开发笔记' },
    { category: 'efficiency', mdFile: 'efficiency-and-skills.md', label: '效率优化' },
  ];

  type SelectFunction = <T>(
    table: string,
    where?: Record<string, unknown>,
    options?: unknown
  ) => T[];
  let dbSelect: SelectFunction;
  try {
    const repo = await import('../db/repository.js');
    dbSelect = repo.select as SelectFunction;
  } catch {
    console.log('   ⚠️  数据库未初始化，跳过');
    return;
  }

  let hasIssues = false;

  for (const check of checks) {
    const mdPath = path.join(winAgentDir, 'docs', check.mdFile);
    const mdContent = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf-8') : '';

    interface KnowledgeRow {
      id: number;
      title: string;
      content: string;
    }
    let dbEntries: KnowledgeRow[];
    try {
      dbEntries = dbSelect<KnowledgeRow>('knowledge', { category: check.category });
    } catch {
      continue; // Table doesn't exist yet
    }

    const onlyInDb: string[] = [];
    const onlyInMd: string[] = [];

    // Check DB entries missing from MD
    for (const entry of dbEntries) {
      if (!mdContent.includes(entry.title)) {
        onlyInDb.push(entry.title);
      }
    }

    // Check MD headings missing from DB (heuristic: ### headings as entries)
    const mdHeadings = mdContent.match(/^###\s+(.+)$/gm);
    if (mdHeadings) {
      const dbTitles = new Set(dbEntries.map((e) => e.title));
      for (const heading of mdHeadings) {
        const title = heading.replace(/^###\s+/, '').trim();
        if (!dbTitles.has(title)) {
          onlyInMd.push(title);
        }
      }
    }

    if (onlyInDb.length > 0 || onlyInMd.length > 0) {
      hasIssues = true;
      console.log(`   ⚠️  ${check.label} (${check.mdFile}):`);
      for (const title of onlyInDb) {
        console.log(`      仅在 DB: ${title}`);
      }
      for (const title of onlyInMd) {
        console.log(`      仅在文件: ${title}`);
      }
    }
  }

  if (!hasIssues) {
    console.log('   ✓ 一致');
  }
}

/**
 * P4: Display effective context rotation thresholds.
 */
function displayRotationThresholds(config: WinAgentConfig): void {
  const inputThreshold = config.contextRotation?.inputThreshold ?? 0.8;
  const anxietyDropRatio = config.contextRotation?.anxietyDropRatio ?? 0.3;

  console.log('\n🔄 上下文轮转配置');
  console.log(
    `   输入阈值: ${Math.round(inputThreshold * 100)}%${config.contextRotation?.inputThreshold ? '' : ' (默认)'}`
  );
  console.log(
    `   焦虑检测: ${Math.round(anxietyDropRatio * 100)}%${config.contextRotation?.anxietyDropRatio ? '' : ' (默认)'}`
  );
}

export async function checkCommand() {
  try {
    await runEnvCheck();
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err.name === 'ExitPromptError' || err.message.includes('User force closed'))
    ) {
      console.log('\n👋 已取消');
      process.exit(0);
    }
    throw err;
  }
}
