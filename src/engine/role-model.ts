import { loadConfig, type ProviderConfig } from '../config/index.js';
import { getOpencodeModelRef, type OpencodeModelRef } from './opencode-config.js';
import { Role } from './role-manager.js';

export function getProviderForRole(role: Role, workspace?: string): ProviderConfig | null {
  const config = loadConfig(workspace);
  if (role !== Role.PM && role !== Role.DEV) return config.provider ?? null;
  return config.roleProviders?.[role] ?? config.provider ?? null;
}

export function getModelForRole(role: Role, workspace?: string): OpencodeModelRef | undefined {
  const provider = getProviderForRole(role, workspace);
  return provider ? getOpencodeModelRef(provider) : undefined;
}
