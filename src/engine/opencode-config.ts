import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { ProviderConfig } from '../config/index.js';

/**
 * Build opencode Config object from win-agent's provider config.
 * Maps win-agent provider settings to the opencode server's expected format.
 */
export function buildOpencodeConfig(provider: ProviderConfig) {
  const isCustom = provider.type === 'custom-openai' || provider.type === 'custom-anthropic';
  const isOpenCode = provider.type === 'opencode-zen' || provider.type === 'opencode-go';

  if (isCustom) {
    const npm =
      provider.type === 'custom-anthropic' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible';
    return {
      model: `custom/${provider.model}`,
      provider: {
        custom: {
          npm,
          models: {
            [provider.model]: {
              name: provider.model,
              tool_call: true,
              ...(provider.reasoning ? { reasoning: true } : {}),
            },
          },
          options: {
            ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
            ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
          },
        },
      },
      permission: {
        edit: 'allow' as const,
        bash: 'allow' as const,
      },
    };
  }

  if (isOpenCode) {
    // OpenCode Zen: opencode/<model-id>
    // OpenCode Go:  opencode-go/<model-id>
    // Both use OPENCODE_API_KEY for authentication
    const providerPrefix = provider.type === 'opencode-zen' ? 'opencode' : 'opencode-go';
    return {
      model: `${providerPrefix}/${provider.model}`,
      provider: {
        ...(provider.apiKey
          ? { [providerPrefix]: { env: [`OPENCODE_API_KEY=${provider.apiKey}`] } }
          : {}),
      },
      permission: {
        edit: 'allow' as const,
        bash: 'allow' as const,
      },
    };
  }

  // Built-in providers (anthropic, openai)
  return {
    model: `${provider.type}/${provider.model}`,
    provider: {
      [provider.type]: {
        ...(provider.apiKey
          ? { env: [`${provider.type.toUpperCase()}_API_KEY=${provider.apiKey}`] }
          : {}),
      },
    },
    permission: {
      edit: 'allow' as const,
      bash: 'allow' as const,
    },
  };
}

/**
 * Ensure the required AI SDK npm package is installed in .opencode/.
 * opencode dynamically imports these packages for custom providers.
 * Also installs sqlite-vec required by the database tool.
 */
export function ensureOpencodePackages(workspace: string, provider: ProviderConfig): void {
  const opencodeDir = path.join(workspace, '.opencode');

  if (!fs.existsSync(opencodeDir)) fs.mkdirSync(opencodeDir, { recursive: true });
  const pkgJsonPath = path.join(opencodeDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    fs.writeFileSync(
      pkgJsonPath,
      JSON.stringify({ name: 'opencode-workspace', private: true }, null, 2),
      'utf-8'
    );
  }

  const needed: string[] = [];

  // 1. Provider SDK package (for custom providers; opencode-zen/opencode-go are built-in)
  const isCustom = provider.type === 'custom-openai' || provider.type === 'custom-anthropic';
  if (isCustom) {
    const npm =
      provider.type === 'custom-anthropic' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible';
    const pkgDir = path.join(opencodeDir, 'node_modules', ...npm.split('/'));
    if (!fs.existsSync(pkgDir)) needed.push(npm);
  }

  // 2. Tool dependencies (required by .opencode/tools/*.ts)
  const toolDeps = ['sqlite-vec'];
  for (const dep of toolDeps) {
    const depDir = path.join(opencodeDir, 'node_modules', dep);
    if (!fs.existsSync(depDir)) needed.push(dep);
  }

  if (needed.length === 0) return;

  console.log(`   → 安装 opencode 依赖: ${needed.join(', ')}...`);
  try {
    execSync(`npm install --save --registry=https://registry.npmmirror.com ${needed.join(' ')}`, {
      cwd: opencodeDir,
      stdio: 'pipe',
      timeout: 120000,
    });
    console.log(`   ✓ 依赖已安装`);
  } catch (err) {
    const error = Object.assign(new Error(`Failed to install opencode packages: ${err}`), {
      code: 'INSTALL_FAILED',
    });
    throw error;
  }
}
