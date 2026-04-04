import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import {
  createOpencodeClient,
  type OpencodeClient,
} from "@opencode-ai/sdk";
import { loadConfig, type ProviderConfig } from "../config/index.js";

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
    const npm = provider.type === "custom-anthropic"
      ? "@ai-sdk/anthropic"
      : "@ai-sdk/openai-compatible";
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
        ...(provider.apiKey ? { env: [`${provider.type.toUpperCase()}_API_KEY=${provider.apiKey}`] } : {}),
      },
    },
    permission: {
      edit: "allow" as const,
      bash: "allow" as const,
    },
  };
}

/**
 * Check if a port is available by attempting to listen on it briefly.
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, "127.0.0.1");
  });
}

/**
 * Find an available port starting from the given port.
 */
async function findAvailablePort(startPort: number, maxAttempts = 30): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available port found in range ${startPort}-${startPort + maxAttempts - 1}`);
}

/**
 * Try connecting to an existing opencode server.
 * Returns client if healthy, null otherwise.
 */
async function tryConnect(url: string): Promise<OpencodeClient | null> {
  try {
    const client = createOpencodeClient({ baseUrl: url });
    await client.session.list(); // health check
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

  // Collect all packages that need to be installed
  const needed: string[] = [];

  // 1. Provider SDK package (for custom providers)
  const isCustom = provider.type === "custom-openai" || provider.type === "custom-anthropic";
  if (isCustom) {
    const npm = provider.type === "custom-anthropic"
      ? "@ai-sdk/anthropic"
      : "@ai-sdk/openai-compatible";
    const pkgDir = path.join(opencodeDir, "node_modules", ...npm.split("/"));
    if (!fs.existsSync(pkgDir)) needed.push(npm);
  }

  // 2. Tool dependencies (required by .opencode/tools/*.ts)
  const toolDeps = ["better-sqlite3", "sqlite-vec"];
  for (const dep of toolDeps) {
    const depDir = path.join(opencodeDir, "node_modules", dep);
    if (!fs.existsSync(depDir)) needed.push(dep);
  }

  if (needed.length === 0) return;

  console.log(`   → 安装 opencode 依赖: ${needed.join(", ")}...`);
  try {
    execSync(`npm install --save ${needed.join(" ")}`, {
      cwd: opencodeDir,
      stdio: "pipe",
      timeout: 120000,
    });
    console.log(`   ✓ 依赖已安装`);
  } catch (err) {
    throw new Error(`Failed to install opencode packages: ${err}`);
  }
}

/**
 * Start or reuse an opencode server for the workspace.
 *
 * 1. Check if a previous server is still running (from opencode-server.json)
 * 2. If alive, reuse it
 * 3. Otherwise, start a new server and persist its info
 */
export async function startOpencodeServer(
  workspace: string,
  port = 4096
): Promise<OpencodeServerHandle> {
  const config = loadConfig(workspace);
  if (!config.provider) {
    throw new Error("Provider not configured. Run `win-agent start` in your project directory.");
  }

  // 1. Try to reuse existing server
  const existing = loadServerInfo(workspace);
  if (existing) {
    const client = await tryConnect(existing.url);
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

  // 3. Start a new server
  const actualPort = await findAvailablePort(port);
  if (actualPort !== port) {
    console.log(`   ℹ️  端口 ${port} 被占用，使用 ${actualPort}`);
  }

  const opcodeConfig = buildOpencodeConfig(config.provider);

  // Debug: show what we're sending to opencode
  console.log(`   [debug] config → opencode: model=${opcodeConfig.model}, provider keys=${Object.keys(opcodeConfig.provider)}`);

  // Spawn opencode server manually so we can see its stderr/stdout
  const opcodeConfigWithLog = { ...opcodeConfig, logLevel: "DEBUG" };
  const proc = spawn("opencode", ["serve", `--hostname=127.0.0.1`, `--port=${actualPort}`, `--log-level=DEBUG`], {
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opcodeConfigWithLog),
    },
  });

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

  const client = createOpencodeClient({ baseUrl: serverUrl });
  const server = { url: serverUrl, close: () => proc.kill() };

  // Debug: check what opencode actually loaded
  try {
    const cfgResult = await client.config.get();
    const loadedModel = cfgResult.data?.model;
    const loadedProviders = cfgResult.data?.provider ? Object.keys(cfgResult.data.provider) : [];
    console.log(`   [debug] opencode loaded: model=${loadedModel}, providers=${JSON.stringify(loadedProviders)}`);
  } catch (err) {
    console.log(`   [debug] config.get() failed: ${err}`);
  }

  // Health check
  try {
    await client.session.list();
  } catch (err) {
    server.close();
    throw new Error(`opencode server health check failed: ${err}`);
  }

  // Persist server info for reuse
  saveServerInfo(workspace, {
    url: server.url,
    port: actualPort,
    startedAt: new Date().toISOString(),
  });

  return {
    client,
    url: server.url,
    owned: true,
    close: server.close,
  };
}
