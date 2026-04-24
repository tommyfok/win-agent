import { execSync } from 'node:child_process';
import {
  loadConfig,
  saveConfig,
  checkEngineRunning,
  type ProviderConfig,
} from '../config/index.js';
import { select, confirm, input } from '@inquirer/prompts';

/**
 * Parse `opencode models` output into provider → models map.
 * Each line is in format: `provider/model-name`
 */
export function parseOpencodeModels(output: string): Map<string, string[]> {
  const providerMap = new Map<string, string[]>();

  output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('/'))
    .forEach((line) => {
      const slashIndex = line.indexOf('/');
      const provider = line.substring(0, slashIndex);
      const model = line.substring(slashIndex + 1);

      if (!providerMap.has(provider)) {
        providerMap.set(provider, []);
      }
      providerMap.get(provider)!.push(model);
    });

  for (const models of providerMap.values()) {
    models.sort();
  }

  return providerMap;
}

/**
 * Fetch available models from `opencode models` CLI command.
 * Returns a Map of provider → sorted model list, or null if command fails.
 */
export function fetchOpencodeModels(): Map<string, string[]> | null {
  try {
    const output = execSync('opencode models 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 15000,
    });
    const models = parseOpencodeModels(output);
    if (models.size > 0) return models;
  } catch {
    // CLI not available or failed
  }
  return null;
}

function formatProvider(provider?: ProviderConfig): string {
  if (!provider?.type || !provider.model) return '未配置';
  return `${provider.type} / ${provider.model}${provider.reasoning ? ' (推理模型)' : ''}`;
}

async function selectProvider(providerMap: Map<string, string[]>): Promise<ProviderConfig> {
  const providers = Array.from(providerMap.keys()).sort();
  console.log(`   ✓ 找到 ${providers.length} 个可用 Provider`);

  const selectedProvider = await select({
    message: '请选择 Provider',
    choices: providers.map((p) => ({ value: p, name: p })),
  });

  const models = providerMap.get(selectedProvider)!;
  const selectedModel = await select({
    message: `请选择 ${selectedProvider} 的模型`,
    choices: models.map((m) => ({ value: m, name: m })),
  });

  return {
    type: selectedProvider,
    apiKey: '',
    model: selectedModel,
  };
}

/**
 * `win-agent model` command — switch the LLM provider/model for the current workspace.
 */
export async function modelCommand() {
  try {
    await _modelCommand();
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

async function _modelCommand() {
  const workspace = process.cwd();
  const config = loadConfig(workspace);

  console.log('\n📦 当前模型配置');
  console.log(`   默认 Provider: ${formatProvider(config.provider)}`);
  console.log(`   PM Provider: ${formatProvider(config.roleProviders?.PM)}`);
  console.log(`   DEV Provider: ${formatProvider(config.roleProviders?.DEV)}`);
  if (config.embedding?.type && config.embedding?.model) {
    console.log(`   Embedding: ${config.embedding.type} / ${config.embedding.model}`);
  } else {
    console.log('   Embedding: 未配置');
  }

  const { running, pid } = checkEngineRunning(workspace);
  if (running) {
    console.log(`\n⚠️  引擎正在运行中 (PID: ${pid})`);
    console.log('   切换模型后需要重启引擎才能生效。');
    const proceed = await confirm({ message: '是否继续切换模型？', default: true });
    if (!proceed) {
      console.log('已取消');
      return;
    }
  }

  const action = await select({
    message: '请选择操作',
    choices: [
      { value: 'switch', name: '切换 LLM Provider / 模型' },
      { value: 'embedding', name: '切换 Embedding 模型' },
      { value: 'both', name: '同时切换两者' },
    ],
  });

  const changeProvider = action === 'switch' || action === 'both';
  const changeEmbedding = action === 'embedding' || action === 'both';

  if (changeProvider) {
    console.log('\n🔧 配置 LLM Provider');
    console.log('   → 获取可用 Provider 列表...');

    const providerMap = fetchOpencodeModels();

    if (!providerMap || providerMap.size === 0) {
      console.log('   ❌ 未检测到可用的 opencode Provider');
      console.log('   💡 请先运行 `opencode auth login` 配置认证信息');
      return;
    }

    const target = await select({
      message: '请选择配置范围',
      choices: [
        { value: 'global', name: '全局默认模型（未单独配置的角色使用）' },
        { value: 'PM', name: '仅 PM 角色' },
        { value: 'DEV', name: '仅 DEV 角色' },
        { value: 'clear-PM', name: '清除 PM 角色覆盖' },
        { value: 'clear-DEV', name: '清除 DEV 角色覆盖' },
      ],
    });

    if (target === 'clear-PM' || target === 'clear-DEV') {
      const role = target === 'clear-PM' ? 'PM' : 'DEV';
      if (config.roleProviders) delete config.roleProviders[role];
      console.log(`   ✓ 已清除 ${role} 角色模型覆盖`);
    } else {
      const selected = await selectProvider(providerMap);
      if (target === 'global') {
        config.provider = selected;
      } else {
        const role = target as 'PM' | 'DEV';
        config.roleProviders = config.roleProviders ?? {};
        config.roleProviders[role] = selected;
      }
      console.log(`   ✓ 已选择: ${target} → ${selected.type} / ${selected.model}`);
    }
  }

  if (changeEmbedding && !changeProvider) {
    console.log('\n🔧 配置 Embedding 模型');
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
      const apiKey = await select({
        message: 'API Key 来源',
        choices: [
          { value: 'reuse', name: `复用当前 Provider 的 Key` },
          { value: 'manual', name: '手动输入' },
        ],
      });

      const finalApiKey =
        apiKey === 'manual'
          ? await input({ message: '请输入 Embedding API Key' })
          : config.provider?.apiKey || '';

      const model = await select({
        message: '请选择 Embedding 模型',
        choices: [
          { value: 'text-embedding-3-small', name: 'text-embedding-3-small' },
          { value: 'text-embedding-3-large', name: 'text-embedding-3-large' },
        ],
      });

      config.embedding = {
        type: embType,
        apiKey: finalApiKey,
        model,
      };
    }
  }

  saveConfig(config, workspace);

  console.log('\n✅ 模型配置已更新');
  console.log(`   默认 Provider: ${formatProvider(config.provider)}`);
  console.log(`   PM Provider: ${formatProvider(config.roleProviders?.PM)}`);
  console.log(`   DEV Provider: ${formatProvider(config.roleProviders?.DEV)}`);
  console.log(`   Embedding: ${config.embedding?.type} / ${config.embedding?.model}`);

  if (running) {
    console.log('\n💡 请重启引擎以使新配置生效：');
    console.log('   npx win-agent restart');
  }
}
