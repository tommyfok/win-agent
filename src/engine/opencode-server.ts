import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { loadConfig, type ProviderConfig, type WinAgentConfig } from "../config/index.js";

/** Build Basic Auth headers if serverPassword is configured */
function buildAuthHeaders(config: WinAgentConfig): Record<string, string> {
  if (!config.serverPassword) return {};
  const user = "opencode";
  const credentials = Buffer.from(`${user}:${config.serverPassword}`).toString("base64");
  return { Authorization: `Basic ${credentials}` };
}

export interface OpencodeServerHandle {
  client: OpencodeClient;
  url: string;
  /** Whether this handle owns the server (started it) vs reusing an existing one */
  owned: boolean;
  close: () => void;
}

/** Persisted server info for reuse across engine restarts */
interface ServerInfo {
  url: string;
  port: number;
  startedAt: string;
}

function serverInfoFile(workspace: string): string {
  return path.join(workspace, ".win-agent", "opencode-server.json");
}

function saveServerInfo(workspace: string, info: ServerInfo): void {
  fs.writeFileSync(serverInfoFile(workspace), JSON.stringify(info, null, 2), "utf-8");
}

function loadServerInfo(workspace: string): ServerInfo | null {
  const file = serverInfoFile(workspace);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

export function removeServerInfo(workspace: string): void {
  const file = serverInfoFile(workspace);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

/**
 * Build opencode Config from win-agent's provider config.
 */
function buildOpencodeConfig(provider: ProviderConfig) {
  const isCustom = provider.type === "custom-openai" || provider.type === "custom-anthropic";

  if (isCustom) {
    const npm =
      provider.type === "custom-anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible";
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
        edit: "allow" as const,
        bash: "allow" as const,
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
      edit: "allow" as const,
      bash: "allow" as const,
    },
  };
}

/**
 * Try connecting to an existing opencode server.
 * Verifies ownership by checking that our persisted PM session ID exists on the server.
 */
async function tryConnect(url: string, workspace: string): Promise<OpencodeClient | null> {
  try {
    const config = loadConfig(workspace);
    const client = createOpencodeClient({ baseUrl: url, headers: buildAuthHeaders(config) });
    // Load our persisted session IDs
    const { SessionManager } = await import("./session-manager.js");
    const savedSessions = SessionManager.loadPersistedSessions(workspace);
    const pmSessionId = savedSessions?.PM;
    if (pmSessionId) {
      // Verify this session exists on the server
      try {
        await client.session.get({ path: { id: pmSessionId } });
      } catch {
        return null; // Our session doesn't exist — not our server
      }
    } else {
      // No saved sessions — just health check
      await client.session.list();
    }
    return client;
  } catch {
    return null;
  }
}

/**
 * Ensure the required AI SDK npm package is installed in .opencode/.
 * opencode dynamically imports these packages for custom providers.
 */
function ensureOpencodePackages(workspace: string, provider: ProviderConfig): void {
  const opencodeDir = path.join(workspace, ".opencode");

  // Ensure .opencode/ dir and package.json exist so npm install works
  if (!fs.existsSync(opencodeDir)) fs.mkdirSync(opencodeDir, { recursive: true });
  const pkgJsonPath = path.join(opencodeDir, "package.json");
  if (!fs.existsSync(pkgJsonPath)) {
    fs.writeFileSync(
      pkgJsonPath,
      JSON.stringify({ name: "opencode-workspace", private: true }, null, 2),
      "utf-8"
    );
  }

  // Collect all packages that need to be installed
  const needed: string[] = [];

  // 1. Provider SDK package (for custom providers)
  const isCustom = provider.type === "custom-openai" || provider.type === "custom-anthropic";
  if (isCustom) {
    const npm =
      provider.type === "custom-anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible";
    const pkgDir = path.join(opencodeDir, "node_modules", ...npm.split("/"));
    if (!fs.existsSync(pkgDir)) needed.push(npm);
  }

  // 2. Tool dependencies (required by .opencode/tools/*.ts)
  // bun:sqlite is built-in; only sqlite-vec needs npm install
  const toolDeps = ["sqlite-vec"];
  for (const dep of toolDeps) {
    const depDir = path.join(opencodeDir, "node_modules", dep);
    if (!fs.existsSync(depDir)) needed.push(dep);
  }

  if (needed.length === 0) return;

  console.log(`   → 安装 opencode 依赖: ${needed.join(", ")}...`);
  try {
    execSync(`npm install --save --registry=https://registry.npmmirror.com ${needed.join(" ")}`, {
      cwd: opencodeDir,
      stdio: "pipe",
      timeout: 120000,
    });
    console.log(`   ✓ 依赖已安装`);
  } catch (err) {
    const error = Object.assign(new Error(`Failed to install opencode packages: ${err}`), {
      code: "INSTALL_FAILED",
    });
    throw error;
  }
}

/**
 * Start or reuse an opencode server for the workspace.
 *
 * 1. Check if a previous server is still running (from opencode-server.json)
 * 2. If alive, reuse it
 * 3. Otherwise, start a new server and persist its info
 */
export async function startOpencodeServer(workspace: string): Promise<OpencodeServerHandle> {
  const config = loadConfig(workspace);
  if (!config.provider) {
    throw new Error("Provider not configured. Run `win-agent start` in your project directory.");
  }

  // 1. Try to reuse existing server
  const existing = loadServerInfo(workspace);
  if (existing) {
    const client = await tryConnect(existing.url, workspace);
    if (client) {
      console.log(`   ✓ 复用已有 opencode server: ${existing.url}`);
      return {
        client,
        url: existing.url,
        owned: false,
        close: () => {}, // Don't close a server we didn't start
      };
    }
    // Server is dead — clean up stale info
    removeServerInfo(workspace);
  }

  // 2. Ensure all opencode packages are installed (provider SDK + tool deps)
  ensureOpencodePackages(workspace, config.provider);

  // 3. Start a new server (port=0 lets the OS assign a free port)
  const opcodeConfig = buildOpencodeConfig(config.provider);

  // Spawn opencode server manually so we can see its stderr/stdout
  const opcodeConfigWithLog = { ...opcodeConfig, logLevel: "DEBUG" };
  const proc = spawn("opencode", ["serve", `--hostname=0.0.0.0`, `--port=0`, `--log-level=DEBUG`], {
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opcodeConfigWithLog),
      ...(config.serverPassword ? { OPENCODE_SERVER_PASSWORD: config.serverPassword } : {}),
    },
    // Detach so the child doesn't receive SIGINT from the terminal's process group.
    // This lets us write memories before shutting down the server.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Don't let the detached child keep the parent alive if cleanup forgets to kill it.
  proc.unref();

  // Forward stderr to console for debugging
  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) console.log(`   [opencode] ${text}`);
  });

  // Wait for server to start (parse stdout for listening message)
  const serverUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("opencode server start timeout")), 10000);
    let output = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const lines = output.split("\n");
      for (const line of lines) {
        if (line.startsWith("opencode server listening")) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (match) {
            clearTimeout(timeout);
            resolve(match[1]);
            return;
          }
        }
      }
    });
    // Also forward stdout after startup
    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text && !text.includes("server listening")) {
        console.log(`   [opencode:stdout] ${text}`);
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`opencode exited with code ${code}\n${output}`));
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  const clientUrl = serverUrl.replace("://0.0.0.0", "://127.0.0.1");
  const client = createOpencodeClient({ baseUrl: clientUrl, headers: buildAuthHeaders(config) });
  const server = {
    url: serverUrl,
    close: () => {
      try {
        // Kill the detached process group
        if (proc.pid) process.kill(-proc.pid, "SIGTERM");
      } catch {
        try {
          proc.kill();
        } catch {
          // process already terminated
        }
      }
    },
  };

  // Health check
  try {
    await client.session.list();
  } catch (err) {
    server.close();
    throw new Error(`opencode server health check failed: ${err}`, { cause: err });
  }

  // Persist server info for reuse
  // Replace 0.0.0.0 with 127.0.0.1 — browsers can't access 0.0.0.0
  const accessibleUrl = server.url.replace("://0.0.0.0", "://127.0.0.1");
  const parsedUrl = new URL(accessibleUrl);
  saveServerInfo(workspace, {
    url: accessibleUrl,
    port: parseInt(parsedUrl.port, 10),
    startedAt: new Date().toISOString(),
  });

  return {
    client,
    url: server.url,
    owned: true,
    close: server.close,
  };
}
