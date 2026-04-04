import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface ProviderConfig {
  type: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  reasoning?: boolean;
}

export interface EmbeddingConfig {
  type: string;
  apiKey: string;
  model: string;
}

export interface WinAgentConfig {
  workspaceId?: string;
  provider?: ProviderConfig;
  embedding?: EmbeddingConfig;
}

/**
 * All config and state live under <workspace>/.win-agent/.
 * Workspace is always the current working directory.
 */
function getWinAgentDir(workspace?: string): string {
  return path.join(workspace ?? process.cwd(), ".win-agent");
}

function configFile(workspace?: string): string {
  return path.join(getWinAgentDir(workspace), "config.json");
}

function pidFile(workspace?: string): string {
  return path.join(getWinAgentDir(workspace), "engine.pid");
}

export function loadConfig(workspace?: string): WinAgentConfig {
  const file = configFile(workspace);
  if (!fs.existsSync(file)) {
    return {};
  }
  const raw = fs.readFileSync(file, "utf-8");
  return JSON.parse(raw);
}

export function saveConfig(config: WinAgentConfig, workspace?: string): void {
  const dir = getWinAgentDir(workspace);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configFile(workspace), JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Get or create a stable workspace ID (short random hex).
 * Stored in config so it survives restarts but is unique per workspace.
 */
export function ensureWorkspaceId(workspace?: string): string {
  const config = loadConfig(workspace);
  if (config.workspaceId) return config.workspaceId;
  const id = crypto.randomBytes(4).toString("hex"); // 8-char hex
  config.workspaceId = id;
  saveConfig(config, workspace);
  return id;
}

export function writePidFile(workspace?: string): void {
  const dir = getWinAgentDir(workspace);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pidFile(workspace), String(process.pid), "utf-8");
}

export function readPidFile(workspace?: string): number | null {
  const file = pidFile(workspace);
  if (!fs.existsSync(file)) {
    return null;
  }
  const pid = parseInt(fs.readFileSync(file, "utf-8").trim(), 10);
  return isNaN(pid) ? null : pid;
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function removePidFile(workspace?: string): void {
  const file = pidFile(workspace);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}

export function checkEngineRunning(workspace?: string): { running: boolean; pid: number | null } {
  const pid = readPidFile(workspace);
  if (pid === null) {
    return { running: false, pid: null };
  }
  if (isProcessRunning(pid)) {
    return { running: true, pid };
  }
  // Stale PID file — clean up
  removePidFile(workspace);
  return { running: false, pid: null };
}

export function getDbPath(workspace: string): string {
  return path.join(workspace, ".win-agent", "win-agent.db");
}
