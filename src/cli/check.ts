import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  loadConfig,
  saveConfig,
  loadPresets,
  upsertPreset,
  type WinAgentConfig,
  type ProviderPreset,
} from '../config/index.js';
import { input, select } from '@inquirer/prompts';

/**
 * Fetch model list from an OpenAI-compatible /models endpoint.
 */
async function fetchModelsOpenAI(baseUrl: string, apiKey: string): Promise<string[]> {
  try {
    const url = baseUrl.replace(/\/+$/, '') + '/models';
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    return (body.data ?? []).map((m) => m.id).sort();
  } catch {
    return [];
  }
}

/**
 * Fetch available models from OpenCode Zen API.
 * Endpoint: https://opencode.ai/zen/v1/models
 */
async function fetchZenModels(apiKey: string): Promise<string[]> {
  try {
    const res = await fetch('https://opencode.ai/zen/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    return (body.data ?? []).map((m) => m.id).sort();
  } catch {
    return [];
  }
}

/**
 * Parse opencode-go models from `opencode models` CLI output.
 */
export function parseGoModelsFromCli(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('opencode-go/'))
    .map((line) => line.replace('opencode-go/', ''))
    .sort();
}

/**
 * Parse opencode-go models from /config/providers JSON response.
 */
export function parseGoModelsFromProviders(body: {
  providers?: Array<{ id: string; models?: Record<string, { id: string }> }>;
}): string[] {
  const providers = body.providers ?? [];
  const goProvider = providers.find((p) => p.id === 'opencode-go');
  if (!goProvider?.models) return [];
  return Object.keys(goProvider.models).sort();
}

/**
 * Fetch available OpenCode Go models.
 * 1. Try running opencode server's /config/providers endpoint.
 * 2. Fallback to `opencode models | grep opencode-go`.
 */
export async function fetchGoModels(_apiKey: string): Promise<string[]> {
  // Method 1: Try running opencode server
  try {
    const workspace = process.cwd();
    const infoFile = `${workspace}/.win-agent/opencode-server.json`;
    let serverUrl = 'http://localhost:4096';

    if (fs.existsSync(infoFile)) {
      const info = JSON.parse(fs.readFileSync(infoFile, 'utf-8'));
      if (info.url) serverUrl = info.url;
    }

    const res = await fetch(`${serverUrl.replace(/\/+$/, '')}/config/providers`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const body = (await res.json()) as {
        providers?: Array<{ id: string; models?: Record<string, { id: string }> }>;
      };
      const models = parseGoModelsFromProviders(body);
      if (models.length > 0) return models;
    }
  } catch {
    // Server not available, try CLI fallback
  }

  // Method 2: Fallback to `opencode models`
  try {
    const output = execSync('opencode models 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 15000,
    });
    const models = parseGoModelsFromCli(output);
    if (models.length > 0) return models;
  } catch {
    // CLI not available
  }

  return [];
}

/**
 * Detect if a model supports reasoning by making a quick test call.
 * Checks if the response contains `reasoning_content` in the message.
 */
async function detectReasoningOpenAI(
  baseUrl: string,
  apiKey: string,
  model: string
): Promise<boolean> {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'say OK' }],
      max_tokens: 100,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) return false;
  const body = (await res.json()) as {
    choices?: Array<{ message?: { reasoning_content?: string } }>;
  };
  return body.choices?.[0]?.message?.reasoning_content !== undefined;
}

/**
 * Build a display label for a preset.
 */
function presetLabel(p: ProviderPreset): string {
  return `${p.name} (${p.provider.type} / ${p.provider.model})`;
}

/**
 * Prompt the user to configure a new provider interactively.
 * Returns a partial config with provider and embedding filled in.
 */
export async function promptNewProvider(_existingProvider?: WinAgentConfig['provider']): Promise<{
  provider: WinAgentConfig['provider'];
  embedding: WinAgentConfig['embedding'];
}> {
  const type = await select({
    message: '请选择 LLM Provider',
    choices: [
      { value: 'anthropic', name: 'Anthropic' },
      { value: 'openai', name: 'OpenAI' },
      { value: 'opencode-zen', name: 'OpenCode Zen（按量付费，多种精选模型）' },
      { value: 'opencode-go', name: 'OpenCode Go（$10/月订阅，低成本模型）' },
      { value: 'custom-openai', name: '自定义（OpenAI 兼容接口）' },
      { value: 'custom-anthropic', name: '自定义（Anthropic 兼容接口）' },
    ],
  });
  const isCustom = type === 'custom-openai' || type === 'custom-anthropic';
  const isOpenCode = type === 'opencode-zen' || type === 'opencode-go';
  let baseUrl: string | undefined;
  if (isCustom) {
    baseUrl = await input({ message: '请输入 API Base URL（如 https://api.example.com/v1）' });
  }

  let apiKey: string;
  if (isOpenCode) {
    console.log('   💡 请在 https://opencode.ai/auth 登录并获取 API Key');
    apiKey = await input({ message: '请输入 OpenCode API Key' });
  } else {
    apiKey = await input({ message: '请输入 API Key' });
  }

  let model: string;
  let reasoning = false;

  if (type === 'opencode-zen') {
    console.log('   → 获取 OpenCode Zen 可用模型列表...');
    const models = await fetchZenModels(apiKey);

    if (models.length > 0) {
      model = await select({
        message: '请选择模型',
        choices: models.map((m) => ({ value: m, name: m })),
      });
    } else {
      console.log('   ⚠️  无法获取模型列表，请手动输入');
      console.log('   💡 模型 ID 格式参见 https://opencode.ai/docs/zen/');
      model = await input({ message: '请输入模型 ID（如 claude-sonnet-4-6）' });
    }
    console.log(`   ✓ 已选择: ${model}`);
  } else if (type === 'opencode-go') {
    console.log('   → 获取 OpenCode Go 可用模型列表...');
    const models = await fetchGoModels(apiKey);

    if (models.length > 0) {
      model = await select({
        message: '请选择 Go 模型',
        choices: models.map((m) => ({ value: m, name: m })),
      });
    } else {
      console.log('   ⚠️  无法获取模型列表，请手动输入');
      console.log('   💡 模型 ID 格式参见 https://opencode.ai/docs/go/');
      model = await input({ message: '请输入模型 ID（如 kimi-k2.5）' });
    }
    console.log(`   ✓ 已选择: ${model}`);
  } else if (type === 'custom-openai' && baseUrl) {
    console.log('   → 获取可用模型列表...');
    const models = await fetchModelsOpenAI(baseUrl, apiKey);

    if (models.length > 0) {
      model = await select({
        message: '请选择模型',
        choices: models.map((m) => ({ value: m, name: m })),
      });
    } else {
      console.log('   ⚠️  无法获取模型列表，请手动输入');
      model = await input({ message: '请输入模型名称' });
    }

    console.log('   → 检测模型类型...');
    reasoning = await detectReasoningOpenAI(baseUrl, apiKey, model);
  } else if (type === 'custom-anthropic') {
    model = await input({ message: '请输入模型名称' });
    if (reasoning) {
      console.log(`   ✓ 检测到推理模型 (reasoning)`);
    } else {
      console.log(`   ✓ 普通模型`);
    }
  } else {
    model = await input({
      message: '请输入模型名称',
      default:
        type === 'anthropic'
          ? 'claude-sonnet-4-20250514'
          : type === 'openai'
            ? 'gpt-4o'
            : undefined,
    });
  }

  const provider = {
    type,
    apiKey,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(reasoning ? { reasoning } : {}),
  };

  // Embedding
  console.log('\n2. Embedding 模型配置');
  const embType = await select({
    message: '请选择 Embedding Provider',
    choices: [
      { value: 'local', name: '本地模型 (bge-small-zh-v1.5, 无需 API)' },
      { value: 'openai', name: 'OpenAI (text-embedding-3-small)' },
    ],
  });

  let embedding: WinAgentConfig['embedding'];
  if (embType === 'local') {
    embedding = { type: 'local', apiKey: '', model: 'Xenova/bge-small-zh-v1.5' };
  } else {
    const embApiKey = await input({
      message: '请输入 Embedding API Key（留空则复用 Provider 的 Key）',
      default: '',
    });
    const embModel = await input({
      message: '请选择 Embedding 模型',
      default: 'text-embedding-3-small',
    });
    embedding = { type: embType, apiKey: embApiKey || apiKey, model: embModel };
  }

  return { provider, embedding };
}

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
  if (config.provider?.type && config.provider?.apiKey && config.provider?.model) {
    console.log(
      `   ✓ 已配置 → ${config.provider.type} / ${config.provider.model}${config.provider.reasoning ? ' (推理模型)' : ''}`
    );
  } else {
    // Check global presets
    const presets = loadPresets();

    if (presets.length > 0) {
      const choice = await select({
        message: '检测到已保存的 Provider 配置，请选择',
        choices: [
          ...presets.map((p) => ({ value: p.name, name: presetLabel(p) })),
          { value: '__new__', name: '➕ 新建配置' },
        ],
      });

      if (choice !== '__new__') {
        const preset = presets.find((p) => p.name === choice)!;
        config.provider = { ...preset.provider };
        config.embedding = { ...preset.embedding };
        changed = true;
        console.log(`   ✓ 使用预设: ${presetLabel(preset)}`);
      } else {
        const result = await promptNewProvider(config.provider);
        config.provider = result.provider;
        config.embedding = result.embedding;
        changed = true;

        // Save to global presets
        const presetName = await input({
          message: '为此配置起个名字（方便下次复用）',
          default: `${config.provider!.type}-${config.provider!.model}`,
        });
        upsertPreset({
          name: presetName,
          provider: config.provider!,
          embedding: config.embedding!,
        });
        console.log(`   ✓ 已保存到全局预设: ${presetName}`);
      }
    } else {
      // No presets — go through full setup
      const result = await promptNewProvider(config.provider);
      config.provider = result.provider;
      config.embedding = result.embedding;
      changed = true;

      // Save to global presets
      const presetName = await input({
        message: '为此配置起个名字（方便下次复用）',
        default: `${config.provider!.type}-${config.provider!.model}`,
      });
      upsertPreset({
        name: presetName,
        provider: config.provider!,
        embedding: config.embedding!,
      });
      console.log(`   ✓ 已保存到全局预设: ${presetName}`);
    }
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
