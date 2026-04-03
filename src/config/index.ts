import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface ProviderConfig {
  type: string;
  apiKey: string;
  model: string;
}

export interface EmbeddingConfig {
  type: string;
  apiKey: string;
  model: string;
}

export interface WinEngineConfig {
  workspace?: string;
  provider?: ProviderConfig;
  embedding?: EmbeddingConfig;
}

const CONFIG_DIR = path.join(os.homedir(), ".win-agent");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const PID_FILE = path.join(CONFIG_DIR, "engine.pid");

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): WinEngineConfig {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    return {};
  }
  const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
  return JSON.parse(raw);
}

export function saveConfig(config: WinEngineConfig): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

export function writePidFile(): void {
  ensureConfigDir();
  fs.writeFileSync(PID_FILE, String(process.pid), "utf-8");
}

export function readPidFile(): number | null {
  if (!fs.existsSync(PID_FILE)) {
    return null;
  }
  const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
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

export function removePidFile(): void {
  if (fs.existsSync(PID_FILE)) {
    fs.unlinkSync(PID_FILE);
  }
}

export function checkEngineRunning(): { running: boolean; pid: number | null } {
  const pid = readPidFile();
  if (pid === null) {
    return { running: false, pid: null };
  }
  if (isProcessRunning(pid)) {
    return { running: true, pid };
  }
  // Stale PID file — clean up
  removePidFile();
  return { running: false, pid: null };
}

export function getWorkspacePath(): string | null {
  const config = loadConfig();
  return config.workspace || null;
}

export function getDbPath(workspace: string): string {
  return path.join(workspace, ".win-agent", "win-agent.db");
}
