import {
  loadConfig,
  saveConfig,
  loadPresets,
  upsertPreset,
  checkEngineRunning,
  type WinAgentConfig,
} from '../config/index.js';
import { select, confirm, input } from '@inquirer/prompts';
import { promptNewProvider } from './check.js';

/**
 * `win-agent model` command — switch the LLM provider/model for the current workspace.
 *
 * If the engine is running, warns the user and requires confirmation (engine must
 * be restarted for changes to take effect).
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

  // Show current configuration
  console.log('\n📦 当前模型配置');
  if (config.provider?.type && config.provider?.model) {
    console.log(
      `   Provider: ${config.provider.type} / ${config.provider.model}${config.provider.reasoning ? ' (推理模型)' : ''}`
    );
  } else {
    console.log('   Provider: 未配置');
  }
  if (config.embedding?.type && config.embedding?.model) {
    console.log(`   Embedding: ${config.embedding.type} / ${config.embedding.model}`);
  } else {
    console.log('   Embedding: 未配置');
  }

  // Warn if engine is running
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

  // Ask what to change
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

    // Offer presets or new config
    const presets = loadPresets();
    let newProvider: WinAgentConfig['provider'];
    let newEmbedding: WinAgentConfig['embedding'] | undefined;

    if (presets.length > 0) {
      const choice = await select({
        message: '请选择 Provider 配置',
        choices: [
          ...presets.map((p) => ({
            value: p.name,
            name: `${p.name} (${p.provider.type} / ${p.provider.model})`,
          })),
          { value: '__new__', name: '➕ 新建配置' },
        ],
      });

      if (choice !== '__new__') {
        const preset = presets.find((p) => p.name === choice)!;
        newProvider = { ...preset.provider };
        if (changeEmbedding || action === 'switch') {
          // When switching from preset, also apply its embedding
          newEmbedding = { ...preset.embedding };
        }
      } else {
        const result = await promptNewProvider(config.provider);
        newProvider = result.provider;
        newEmbedding = result.embedding;

        // Save to global presets
        const presetName = await input({
          message: '为此配置起个名字（方便下次复用）',
          default: `${newProvider!.type}-${newProvider!.model}`,
        });
        upsertPreset({
          name: presetName,
          provider: newProvider!,
          embedding: newEmbedding!,
        });
        console.log(`   ✓ 已保存到全局预设: ${presetName}`);
      }
    } else {
      const result = await promptNewProvider(config.provider);
      newProvider = result.provider;
      newEmbedding = result.embedding;

      // Save to global presets
      const presetName = await input({
        message: '为此配置起个名字（方便下次复用）',
        default: `${newProvider!.type}-${newProvider!.model}`,
      });
      upsertPreset({
        name: presetName,
        provider: newProvider!,
        embedding: newEmbedding!,
      });
      console.log(`   ✓ 已保存到全局预设: ${presetName}`);
    }

    config.provider = newProvider;
    if (newEmbedding) {
      config.embedding = newEmbedding;
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
  }

  // Save
  saveConfig(config, workspace);

  console.log('\n✅ 模型配置已更新');
  console.log(
    `   Provider: ${config.provider?.type} / ${config.provider?.model}${config.provider?.reasoning ? ' (推理模型)' : ''}`
  );
  console.log(`   Embedding: ${config.embedding?.type} / ${config.embedding?.model}`);

  if (running) {
    console.log('\n💡 请重启引擎以使新配置生效：');
    console.log('   npx win-agent restart');
  }
}
