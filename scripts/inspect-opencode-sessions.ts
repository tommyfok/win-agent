import fs from 'node:fs';
import path from 'node:path';
import { createOpencodeClient } from '@opencode-ai/sdk';

interface ServerInfo {
  url?: string;
  port?: number;
  pid?: number | null;
  startedAt?: string;
}

interface WinAgentConfig {
  serverPassword?: string;
}

type JsonObject = Record<string, unknown>;

function readJsonFile<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch (err) {
    console.error(`Failed to parse ${file}:`, err);
    return null;
  }
}

function buildAuthHeaders(config: WinAgentConfig | null): Record<string, string> {
  if (!config?.serverPassword) return {};
  const credentials = Buffer.from(`opencode:${config.serverPassword}`).toString('base64');
  return { Authorization: `Basic ${credentials}` };
}

function getKnownSessionIds(workspace: string): Map<string, string> {
  const sessionsFile = path.join(workspace, '.win-agent', 'sessions.json');
  const persisted = readJsonFile<Record<string, string>>(sessionsFile) ?? {};
  return new Map(Object.entries(persisted));
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as JsonObject;
  const id = row.id ?? row.sessionID ?? row.sessionId;
  return typeof id === 'string' ? id : null;
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
}

async function main(): Promise<void> {
  const workspace = path.resolve(process.argv[2] ?? process.cwd());
  const winAgentDir = path.join(workspace, '.win-agent');
  const serverInfoFile = path.join(winAgentDir, 'opencode-server.json');
  const configFile = path.join(winAgentDir, 'config.json');

  const serverInfo = readJsonFile<ServerInfo>(serverInfoFile);
  if (!serverInfo?.url) {
    console.error(`No opencode server info found at ${serverInfoFile}`);
    console.error('Start win-agent first, or pass the workspace path as the first argument.');
    process.exitCode = 1;
    return;
  }

  const config = readJsonFile<WinAgentConfig>(configFile);
  const client = createOpencodeClient({
    baseUrl: serverInfo.url,
    headers: buildAuthHeaders(config),
  });

  console.log('='.repeat(80));
  console.log('Workspace:', workspace);
  console.log('Server:', stringify(serverInfo));
  console.log('='.repeat(80));

  const persistedSessions = getKnownSessionIds(workspace);
  console.log('\nPersisted sessions (.win-agent/sessions.json):');
  if (persistedSessions.size === 0) {
    console.log('  <none>');
  } else {
    for (const [name, id] of persistedSessions) {
      console.log(`  ${name}: ${id}`);
    }
  }

  let listData: unknown = null;
  try {
    const result = await client.session.list();
    listData = result.data;
    console.log('\nclient.session.list():');
    console.log(stringify(listData));
  } catch (err) {
    console.log('\nclient.session.list() failed:');
    console.log(err);
  }

  let statusData: Record<string, unknown> = {};
  try {
    const result = await client.session.status();
    statusData = (result.data ?? {}) as Record<string, unknown>;
    console.log('\nclient.session.status():');
    console.log(stringify(statusData));
  } catch (err) {
    console.log('\nclient.session.status() failed:');
    console.log(err);
  }

  const ids = new Map<string, string>();
  for (const [name, id] of persistedSessions) ids.set(id, `persisted:${name}`);
  for (const row of asArray(listData)) {
    const id = getId(row);
    if (id && !ids.has(id)) ids.set(id, 'list');
  }
  for (const id of Object.keys(statusData)) {
    if (!ids.has(id)) ids.set(id, 'status');
  }

  console.log('\nPer-session probes:');
  if (ids.size === 0) {
    console.log('  <no session ids from persisted/list/status>');
    return;
  }

  for (const [id, source] of ids) {
    console.log('\n' + '-'.repeat(80));
    console.log(`session ${id} (${source})`);
    console.log('statusMap entry:', stringify(statusData[id] ?? null));

    try {
      const got = await client.session.get({ path: { id } });
      console.log('session.get(): OK');
      console.log(stringify(got.data));
    } catch (err) {
      console.log('session.get(): FAILED');
      console.log(err);
    }

    try {
      const messages = await client.session.messages({
        path: { id },
        query: { limit: 1 },
      });
      console.log('session.messages(limit=1):');
      console.log(stringify(messages.data ?? []));
    } catch (err) {
      console.log('session.messages(limit=1): FAILED');
      console.log(err);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
