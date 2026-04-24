import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';
import { loadConfig, type WinAgentConfig } from '../config/index.js';
import { buildOpencodeConfig, ensureOpencodePackages } from './opencode-config.js';
import { logger } from '../utils/logger.js';

/** Build Basic Auth headers if serverPassword is configured */
function buildAuthHeaders(config: WinAgentConfig): Record<string, string> {
  if (!config.serverPassword) return {};
  const user = 'opencode';
  const credentials = Buffer.from(`${user}:${config.serverPassword}`).toString('base64');
  return { Authorization: `Basic ${credentials}` };
}

export interface OpencodeServerHandle {
  client: OpencodeClient;
  url: string;
  /** The opencode server process PID (only set when owned) */
  pid: number | null;
  /** Whether this handle owns the server (started it) vs reusing an existing one */
  owned: boolean;
  close: () => void;
}

/** Persisted server info for reuse across engine restarts */
interface ServerInfo {
  url: string;
  port: number;
  pid: number | null;
  startedAt: string;
}

function serverInfoFile(workspace: string): string {
  return path.join(workspace, '.win-agent', 'opencode-server.json');
}

function saveServerInfo(workspace: string, info: ServerInfo): void {
  fs.writeFileSync(serverInfoFile(workspace), JSON.stringify(info, null, 2), 'utf-8');
}

function loadServerInfo(workspace: string): ServerInfo | null {
  const file = serverInfoFile(workspace);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

export function removeServerInfo(workspace: string): void {
  const file = serverInfoFile(workspace);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

/** Read the opencode server PID from persisted info (for use by stop command). */
export function loadServerPid(workspace: string): number | null {
  return loadServerInfo(workspace)?.pid ?? null;
}

/**
 * Recursively kill a process and all its descendants (children, grandchildren, etc.).
 * Kills bottom-up (leaf processes first) to avoid orphaning.
 */
export function killProcessTree(pid: number): void {
  let children: number[] = [];
  try {
    const result = execSync(`pgrep -P ${pid}`, { encoding: 'utf-8', timeout: 5000 }).trim();
    if (result) {
      children = result
        .split('\n')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n) && n > 0);
    }
  } catch {
    /* no children or pgrep failed */
  }

  for (const child of children) {
    killProcessTree(child);
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* already dead */
  }
}

/**
 * Check if a given PID belongs to the specified workspace.
 *
 * Uses two independent signals (both must match when applicable):
 * 1. The process's working directory (via `lsof -p <pid> -a -d cwd -Fn`) equals workspace
 * 2. The process's environment contains `WIN_AGENT_WORKSPACE=<workspace>`
 *    (via `ps -E -p <pid>` on macOS, or `/proc/<pid>/environ` on Linux)
 *
 * If neither signal is obtainable, returns `false` (conservative — do NOT kill).
 * This prevents cross-workspace process killing during `ps`-based orphan scans.
 */
export function isProcessInWorkspace(pid: number, workspace: string): boolean {
  let cwdMatches: boolean | null = null;
  let envMatches: boolean | null = null;

  // 1. Check process's working directory (portable across macOS & Linux)
  try {
    const out = execSync(`lsof -p ${pid} -a -d cwd -Fn`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // lsof -Fn output line for cwd starts with 'n'
    const cwdLine = out.split('\n').find((l) => l.startsWith('n'));
    if (cwdLine) {
      const cwd = cwdLine.slice(1);
      cwdMatches = cwd === workspace;
    }
  } catch {
    /* lsof missing or permission denied */
  }

  // 2. Check process's environment for WIN_AGENT_WORKSPACE
  const marker = `WIN_AGENT_WORKSPACE=${workspace}`;
  try {
    if (process.platform === 'linux') {
      const environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf-8');
      const vars = environ.split('\0');
      envMatches = vars.includes(marker);
    } else if (process.platform === 'darwin') {
      // ps -E prints command + environment on macOS
      const out = execSync(`ps -E -p ${pid} -o command=`, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      envMatches = out.includes(marker);
    }
  } catch {
    /* ps/proc unavailable */
  }

  // Conservative: require at least one positive match, and no explicit negative
  if (cwdMatches === true || envMatches === true) {
    // If the other signal is explicitly false, that's a mismatch → not ours
    if (cwdMatches === false || envMatches === false) return false;
    return true;
  }
  return false;
}

/**
 * Try connecting to an existing opencode server.
 * Verifies ownership by checking that our persisted PM session ID exists on the server.
 */
async function tryConnect(url: string, workspace: string): Promise<OpencodeClient | null> {
  try {
    const config = loadConfig(workspace);
    const client = createOpencodeClient({ baseUrl: url, headers: buildAuthHeaders(config) });
    const { SessionManager } = await import('./session-manager.js');
    const savedSessions = SessionManager.loadPersistedSessions(workspace);
    const pmSessionId = savedSessions?.PM;
    if (pmSessionId) {
      try {
        await client.session.get({ path: { id: pmSessionId } });
      } catch {
        return null;
      }
    } else {
      await client.session.list();
    }
    return client;
  } catch {
    return null;
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
    throw new Error('Provider not configured. Run `win-agent start` in your project directory.');
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
        pid: existing.pid,
        owned: false,
        close: () => {},
      };
    }
    removeServerInfo(workspace);
  }

  // 2. Ensure all opencode packages are installed
  ensureOpencodePackages(workspace, [config.provider, ...Object.values(config.roleProviders ?? {})]);

  // 3. Start a new server (port=0 lets the OS assign a free port)
  const opcodeConfig = buildOpencodeConfig(config.provider, config.roleProviders);
  const opcodeConfigWithLog = { ...opcodeConfig, logLevel: 'DEBUG' };

  const proc = spawn('opencode', ['serve', `--hostname=0.0.0.0`, `--port=0`, `--log-level=DEBUG`], {
    // Explicit cwd so `lsof -p <pid> -d cwd` reports the workspace path —
    // this (plus WIN_AGENT_WORKSPACE env) lets `stop`/`clean` scans identify
    // orphaned opencode serve processes that belong to this workspace and skip
    // those belonging to other workspaces.
    cwd: workspace,
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opcodeConfigWithLog),
      // Tag the process env so scans can filter by workspace
      WIN_AGENT_WORKSPACE: workspace,
      ...(config.serverPassword ? { OPENCODE_SERVER_PASSWORD: config.serverPassword } : {}),
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.unref();

  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) console.log(`   [opencode] ${text}`);
  });

  // Wait for server to start (parse stdout for listening message)
  const serverUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('opencode server start timeout')), 10000);
    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const lines = output.split('\n');
      for (const line of lines) {
        if (line.startsWith('opencode server listening')) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (match) {
            clearTimeout(timeout);
            resolve(match[1]);
            return;
          }
        }
      }
    });
    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text && !text.includes('server listening')) {
        console.log(`   [opencode:stdout] ${text}`);
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`opencode exited with code ${code}\n${output}`));
    });
    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  const clientUrl = serverUrl.replace('://0.0.0.0', '://127.0.0.1');
  const client = createOpencodeClient({ baseUrl: clientUrl, headers: buildAuthHeaders(config) });
  const server = {
    url: serverUrl,
    close: () => {
      try {
        if (proc.pid) process.kill(-proc.pid, 'SIGTERM');
      } catch {
        try {
          proc.kill();
        } catch {
          /* process already terminated */
        }
      }
    },
  };

  // Health check
  try {
    const sessions = await client.session.list();
    logger.info(() => ({ sessions }), 'opencode server health check');
  } catch (err) {
    server.close();
    throw new Error(`opencode server health check failed: ${err}`, { cause: err });
  }

  const accessibleUrl = server.url.replace('://0.0.0.0', '://127.0.0.1');
  const parsedUrl = new URL(accessibleUrl);
  saveServerInfo(workspace, {
    url: accessibleUrl,
    port: parseInt(parsedUrl.port, 10),
    pid: proc.pid ?? null,
    startedAt: new Date().toISOString(),
  });

  return {
    client,
    url: server.url,
    pid: proc.pid ?? null,
    owned: true,
    close: server.close,
  };
}
