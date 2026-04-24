import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { ProviderConfig } from '../config/index.js';

export interface OpencodeModelRef {
  providerID: string;
  modelID: string;
}

type OpencodeProviderSection = Record<string, unknown>;

function providerPrefix(provider: ProviderConfig): string {
  if (provider.type === 'opencode-zen') return 'opencode';
  if (provider.type === 'opencode-go') return 'opencode-go';
  if (provider.type === 'custom-openai' || provider.type === 'custom-anthropic') return 'custom';
  return provider.type;
}

export function getOpencodeModelRef(provider: ProviderConfig): OpencodeModelRef {
  return {
    providerID: providerPrefix(provider),
    modelID: provider.model,
  };
}

export function getOpencodeModelString(provider: ProviderConfig): string {
  const { providerID, modelID } = getOpencodeModelRef(provider);
  return `${providerID}/${modelID}`;
}

function customProviderConfig(provider: ProviderConfig): OpencodeProviderSection {
  const npm =
    provider.type === 'custom-anthropic' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible';
  return {
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
  };
}

function providerConfig(provider: ProviderConfig): OpencodeProviderSection {
  const isCustom = provider.type === 'custom-openai' || provider.type === 'custom-anthropic';
  if (isCustom) return customProviderConfig(provider);

  const prefix = providerPrefix(provider);
  const envName =
    provider.type === 'opencode-zen' || provider.type === 'opencode-go'
      ? 'OPENCODE_API_KEY'
      : `${provider.type.toUpperCase()}_API_KEY`;

  if (!provider.apiKey && (provider.type === 'opencode-zen' || provider.type === 'opencode-go')) {
    return {};
  }

  return {
    [prefix]: {
      ...(provider.apiKey ? { env: [`${envName}=${provider.apiKey}`] } : {}),
    },
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function mergeProviderSection(
  target: OpencodeProviderSection,
  source: OpencodeProviderSection
): void {
  for (const [key, value] of Object.entries(source)) {
    if (!(key in target)) {
      target[key] = value;
      continue;
    }

    if (key !== 'custom') {
      if (!sameJson(target[key], value)) {
        throw new Error(`Conflicting opencode provider config for "${key}"`);
      }
      continue;
    }

    const existing = target.custom as {
      npm?: string;
      models?: Record<string, unknown>;
      options?: Record<string, unknown>;
    };
    const incoming = value as {
      npm?: string;
      models?: Record<string, unknown>;
      options?: Record<string, unknown>;
    };

    if (existing.npm !== incoming.npm || !sameJson(existing.options ?? {}, incoming.options ?? {})) {
      throw new Error(
        'Conflicting custom provider config. Per-role custom models must share the same SDK, baseUrl, and apiKey.'
      );
    }

    existing.models = {
      ...(existing.models ?? {}),
      ...(incoming.models ?? {}),
    };
  }
}

/**
 * Build opencode Config object from win-agent's provider config.
 * Maps win-agent provider settings to the opencode server's expected format.
 */
export function buildOpencodeConfig(
  provider: ProviderConfig,
  roleProviders?: Partial<Record<'PM' | 'DEV', ProviderConfig>>
) {
  const mergedProvider: OpencodeProviderSection = {};
  for (const p of [provider, ...Object.values(roleProviders ?? {})]) {
    mergeProviderSection(mergedProvider, providerConfig(p));
  }

  return {
    model: getOpencodeModelString(provider),
    provider: mergedProvider,
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
export function ensureOpencodePackages(
  workspace: string,
  providerOrProviders: ProviderConfig | ProviderConfig[]
): void {
  const opencodeDir = path.join(workspace, '.opencode');
  const providers = Array.isArray(providerOrProviders) ? providerOrProviders : [providerOrProviders];

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
  for (const provider of providers) {
    const isCustom = provider.type === 'custom-openai' || provider.type === 'custom-anthropic';
    if (!isCustom) continue;
    const npm =
      provider.type === 'custom-anthropic' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible';
    const pkgDir = path.join(opencodeDir, 'node_modules', ...npm.split('/'));
    if (!fs.existsSync(pkgDir) && !needed.includes(npm)) needed.push(npm);
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
