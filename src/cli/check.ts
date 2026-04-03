import { loadConfig, saveConfig, type WinEngineConfig } from "../config/index.js";
import { input, select } from "@inquirer/prompts";

/**
 * Validate config completeness without interactive prompts.
 * Returns list of missing items. Empty list means all good.
 */
export function validateConfig(config: WinEngineConfig): string[] {
  const missing: string[] = [];
  if (!config.workspace) missing.push("workspace");
  if (!config.provider?.type || !config.provider?.apiKey || !config.provider?.model) {
    missing.push("provider");
  }
  if (!config.embedding?.type) {
    missing.push("embedding");
  }
  // OpenAI embedding needs apiKey; local does not
  if (config.embedding?.type === "openai" && !config.embedding?.apiKey) {
    missing.push("embedding");
  }
  return missing;
}

/**
 * Run interactive environment check. Prompts for missing config items.
 * Returns the validated config.
 */
export async function runEnvCheck(): Promise<WinEngineConfig> {
  console.log("\n🔍 环境检查中...\n");

  let config = loadConfig();
  let changed = false;

  // 1. Workspace
  console.log("1. 工作空间配置");
  if (config.workspace) {
    console.log(`   ✓ 已配置 → ${config.workspace}`);
  } else {
    const workspace = await input({
      message: "请输入工作空间路径（项目代码所在目录）",
    });
    config.workspace = workspace;
    changed = true;
  }

  // 2. Provider/Model
  console.log("\n2. OpenCode Provider/Model 配置");
  if (config.provider?.type && config.provider?.apiKey && config.provider?.model) {
    console.log(`   ✓ 已配置 → ${config.provider.type} / ${config.provider.model}`);
  } else {
    const type = await select({
      message: "请选择 LLM Provider",
      choices: [
        { value: "anthropic", name: "Anthropic" },
        { value: "openai", name: "OpenAI" },
        { value: "custom", name: "自定义" },
      ],
    });
    const apiKey = await input({ message: "请输入 API Key" });
    const model = await input({
      message: "请输入模型名称",
      default: type === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4o",
    });
    config.provider = { type, apiKey, model };
    changed = true;
  }

  // 3. Embedding
  console.log("\n3. Embedding 模型配置");
  if (config.embedding?.type) {
    console.log(`   ✓ 已配置 → ${config.embedding.type} / ${config.embedding.model || "default"}`);
  } else {
    const type = await select({
      message: "请选择 Embedding Provider",
      choices: [
        { value: "local", name: "本地模型 (bge-small-zh-v1.5, 无需 API)" },
        { value: "openai", name: "OpenAI (text-embedding-3-small)" },
      ],
    });

    if (type === "local") {
      config.embedding = {
        type: "local",
        apiKey: "",
        model: "Xenova/bge-small-zh-v1.5",
      };
    } else {
      const apiKey = await input({
        message: "请输入 Embedding API Key（留空则复用 Provider 的 Key）",
        default: "",
      });
      const model = await input({
        message: "请选择 Embedding 模型",
        default: "text-embedding-3-small",
      });
      config.embedding = {
        type,
        apiKey: apiKey || config.provider?.apiKey || "",
        model,
      };
    }
    changed = true;
  }

  if (changed) {
    saveConfig(config);
  }

  console.log("\n✅ 环境检查通过");
  console.log(`   工作空间: ${config.workspace}`);
  console.log(`   Provider: ${config.provider?.type} / ${config.provider?.model}`);
  console.log(`   Embedding: ${config.embedding?.type} / ${config.embedding?.model}`);

  return config;
}

export async function checkCommand() {
  await runEnvCheck();
}
