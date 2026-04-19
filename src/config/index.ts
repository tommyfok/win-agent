import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

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

export interface ContextRotationConfig {
  /** Rotate when input tokens exceed this fraction of max context (default: 0.8) */
  inputThreshold?: number;
  /** Context anxiety: output drop ratio triggering early rotation (default: 0.3) */
  anxietyDropRatio?: number;
}

export interface EngineConfig {
  /** 调度循环间隔，默认 1000ms */
  tickIntervalMs?: number;
  /** PM dispatch 后冷却时间，默认 3000ms */
  pmCooldownMs?: number;
  /** 触发打回率告警的最少任务数，默认 3 */
  minTasksForRejectionStats?: number;
  /** 打回率告警阈值，默认 0.3（30%） */
  rejectionRateThreshold?: number;
  /** 单次 dispatch 超时时间，默认3600000ms */
  dispatchTimeoutMs?: number;
  /** session 初始化等待超时，默认 60000ms */
  sessionInitTimeoutMs?: number;
}

export interface WinAgentConfig {
  workspaceId?: string;
  provider?: ProviderConfig;
  embedding?: EmbeddingConfig;
  serverPassword?: string;
  contextRotation?: ContextRotationConfig;
  engine?: EngineConfig;
}

/** A named provider+embedding preset stored globally. */
export interface ProviderPreset {
  name: string;
  provider: ProviderConfig;
  embedding: EmbeddingConfig;
}

/**
 * All config and state live under <workspace>/.win-agent/.
 * Workspace is always the current working directory.
 */
function getWinAgentDir(workspace?: string): string {
  return path.join(workspace ?? process.cwd(), '.win-agent');
}

// ── Global presets (~/.win-agent/providers.json) ──

function globalDir(): string {
  return path.join(os.homedir(), '.win-agent');
}

function presetsFile(): string {
  return path.join(globalDir(), 'providers.json');
}

export function loadPresets(): ProviderPreset[] {
  const file = presetsFile();
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
}

export function savePresets(presets: ProviderPreset[]): void {
  const dir = globalDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(presetsFile(), JSON.stringify(presets, null, 2), 'utf-8');
}

/** Add or update a preset by name. */
export function upsertPreset(preset: ProviderPreset): void {
  const presets = loadPresets();
  const idx = presets.findIndex((p) => p.name === preset.name);
  if (idx >= 0) {
    presets[idx] = preset;
  } else {
    presets.push(preset);
  }
  savePresets(presets);
}

function configFile(workspace?: string): string {
  return path.join(getWinAgentDir(workspace), 'config.json');
}

function pidFile(workspace?: string): string {
  return path.join(getWinAgentDir(workspace), 'engine.pid');
}

export function loadConfig(workspace?: string): WinAgentConfig {
  const file = configFile(workspace);
  if (!fs.existsSync(file)) {
    return {};
  }
  const raw = fs.readFileSync(file, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`配置文件损坏: ${file}。请删除该文件并重新运行。`);
  }
}

export function saveConfig(config: WinAgentConfig, workspace?: string): void {
  const dir = getWinAgentDir(workspace);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configFile(workspace), JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Get or create a stable workspace ID (short random hex).
 * Stored in config so it survives restarts but is unique per workspace.
 */
export function ensureWorkspaceId(workspace?: string): string {
  const config = loadConfig(workspace);
  if (config.workspaceId) return config.workspaceId;
  const id = crypto.randomBytes(4).toString('hex'); // 8-char hex
  config.workspaceId = id;
  saveConfig(config, workspace);
  return id;
}

export function writePidFile(workspace?: string, pid?: number): void {
  const dir = getWinAgentDir(workspace);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pidFile(workspace), String(pid ?? process.pid), 'utf-8');
}

export function readPidFile(workspace?: string): number | null {
  const file = pidFile(workspace);
  if (!fs.existsSync(file)) {
    return null;
  }
  const pid = parseInt(fs.readFileSync(file, 'utf-8').trim(), 10);
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
  return path.join(workspace, '.win-agent', 'win-agent.db');
}
