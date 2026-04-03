import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk";
import { loadConfig, type ProviderConfig } from "../config/index.js";

export interface OpencodeServerHandle {
  client: OpencodeClient;
  url: string;
  close: () => void;
}

/**
 * Build opencode Config from win-agent's provider config.
 * Maps our simplified config format to opencode's provider config structure.
 */
function buildOpencodeConfig(provider: ProviderConfig) {
  const model = `${provider.type}/${provider.model}`;

  return {
    model,
    provider: {
      [provider.type]: {
        ...(provider.apiKey ? { env: [`${provider.type.toUpperCase()}_API_KEY=${provider.apiKey}`] } : {}),
      },
    },
    // Auto-approve all tool calls (agents run autonomously)
    permission: {
      edit: "allow" as const,
      bash: "allow" as const,
    },
  };
}

/**
 * Start the opencode server and return a client handle.
 * The server hosts all agent sessions and provides the LLM gateway.
 */
export async function startOpencodeServer(
  workspace: string,
  port = 4096
): Promise<OpencodeServerHandle> {
  const config = loadConfig();
  if (!config.provider) {
    throw new Error("Provider not configured. Run `npx win-agent` to configure.");
  }

  const opcodeConfig = buildOpencodeConfig(config.provider);

  const { client, server } = await createOpencode({
    port,
    config: opcodeConfig,
  });

  // Health check: verify server is reachable by listing sessions
  try {
    await client.session.list();
  } catch (err) {
    server.close();
    throw new Error(`opencode server health check failed: ${err}`);
  }

  return {
    client,
    url: server.url,
    close: server.close,
  };
}
