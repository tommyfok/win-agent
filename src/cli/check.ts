import { loadConfig, saveConfig, type WinAgentConfig } from "../config/index.js";
import { input, select } from "@inquirer/prompts";

interface ModelInfo {
  id: string;
  reasoning: boolean;
}

/**
 * Fetch model list from an OpenAI-compatible /models endpoint.
 */
async function fetchModelsOpenAI(baseUrl: string, apiKey: string): Promise<string[]> {
  try {
    const url = baseUrl.replace(/\/+$/, "") + "/models";
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const body = await res.json() as { data?: Array<{ id: string }> };
    return (body.data ?? []).map((m) => m.id).sort();
  } catch {
    return [];
  }
}

/**
 * Detect if a model supports reasoning by making a quick test call.
 * Checks if the response contains `reasoning_content` in the message.
 */
async function detectReasoningOpenAI(baseUrl: string, apiKey: string, model: string): Promise<boolean> {
  const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "say OK" }],
      max_tokens: 100,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) return false;
  const body = await res.json() as {
    choices?: Array<{ message?: { reasoning_content?: string } }>;
  };
  return body.choices?.[0]?.message?.reasoning_content !== undefined;
}


/**
 * Run interactive environment check. Prompts for missing config items.
 * Config is stored in <cwd>/.win-agent/config.json.
 * Returns the validated config and workspace path.
 */
export async function runEnvCheck(): Promise<{ config: WinAgentConfig; workspace: string }> {
  const workspace = process.cwd();
  console.log("\n🔍 环境检查中...\n");
  console.log(`工作空间: ${workspace}`);

  let config = loadConfig(workspace);
  let changed = false;

  // 1. Provider/Model
  console.log("\n1. LLM Provider 配置");
  if (config.provider?.type && config.provider?.apiKey && config.provider?.model) {
    console.log(`   ✓ 已配置 → ${config.provider.type} / ${config.provider.model}${config.provider.reasoning ? " (推理模型)" : ""}`);
  } else {
    const type = await select({
      message: "请选择 LLM Provider",
      choices: [
        { value: "anthropic", name: "Anthropic" },
        { value: "openai", name: "OpenAI" },
        { value: "custom-openai", name: "自定义（OpenAI 兼容接口）" },
        { value: "custom-anthropic", name: "自定义（Anthropic 兼容接口）" },
      ],
    });
    const isCustom = type === "custom-openai" || type === "custom-anthropic";
    let baseUrl: string | undefined;
    if (isCustom) {
      baseUrl = await input({ message: "请输入 API Base URL（如 https://api.example.com/v1）" });
    }
    const apiKey = await input({ message: "请输入 API Key" });

    // Try to fetch model list for custom providers
    let model: string;
    let reasoning = false;

    if (type === "custom-openai" && baseUrl) {
      console.log("   → 获取可用模型列表...");
      const models = await fetchModelsOpenAI(baseUrl, apiKey);

      if (models.length > 0) {
        model = await select({
          message: "请选择模型",
          choices: models.map((m) => ({ value: m, name: m })),
        });
      } else {
        console.log("   ⚠️  无法获取模型列表，请手动输入");
        model = await input({ message: "请输入模型名称" });
      }

      // Auto-detect reasoning
      console.log("   → 检测模型类型...");
      reasoning = await detectReasoningOpenAI(baseUrl, apiKey, model);
    } else if (type === "custom-anthropic") {
      model = await input({ message: "请输入模型名称" });
      if (reasoning) {
        console.log(`   ✓ 检测到推理模型 (reasoning)`);
      } else {
        console.log(`   ✓ 普通模型`);
      }
    } else {
      model = await input({
        message: "请输入模型名称",
        default: type === "anthropic" ? "claude-sonnet-4-20250514" : type === "openai" ? "gpt-4o" : undefined,
      });
    }

    config.provider = {
      type, apiKey, model,
      ...(baseUrl ? { baseUrl } : {}),
      ...(reasoning ? { reasoning } : {}),
    };
    changed = true;
  }

  // 2. Embedding
  console.log("\n2. Embedding 模型配置");
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
    saveConfig(config, workspace);
  }

  console.log("\n✅ 环境检查通过");
  console.log(`   Provider: ${config.provider?.type} / ${config.provider?.model}${config.provider?.reasoning ? " (推理模型)" : ""}`);
  console.log(`   Embedding: ${config.embedding?.type} / ${config.embedding?.model}`);

  return { config, workspace };
}

export async function checkCommand() {
  try {
    await runEnvCheck();
  } catch (err: any) {
    if (err?.name === "ExitPromptError" || err?.message?.includes("User force closed")) {
      console.log("\n👋 已取消");
      process.exit(0);
    }
    throw err;
  }
}
