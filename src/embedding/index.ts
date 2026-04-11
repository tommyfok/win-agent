import crypto from 'node:crypto';
import { LRUCache } from 'lru-cache';
import { loadConfig } from '../config/index.js';
import { createOpenAIEmbedding } from './openai.js';
import { createLocalEmbedding } from './local.js';

/**
 * Embedding provider interface.
 */
export interface EmbeddingProvider {
  generate(text: string): Promise<number[]>;
}

/** Embedding dimension by provider type */
const DIMENSIONS: Record<string, number> = {
  local: 512, // bge-small-zh-v1.5
  openai: 1536, // text-embedding-3-small
};

let provider: EmbeddingProvider | null = null;

// LRU cache keyed by SHA-256 prefix of the text; max 500 entries (~2MB for 1536-dim float32)
const embedCache = new LRUCache<string, number[]>({ max: 500 });

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Get the embedding dimension for the configured provider.
 */
export function getEmbeddingDimension(workspace?: string): number {
  const config = loadConfig(workspace);
  const type = config.embedding?.type ?? 'local';
  return DIMENSIONS[type] ?? 384;
}

/**
 * Get the configured embedding provider (singleton).
 */
export function getEmbeddingProvider(workspace?: string): EmbeddingProvider {
  if (provider) return provider;

  const config = loadConfig(workspace);
  const embeddingConfig = config.embedding;

  // Default to local if not configured
  const type = embeddingConfig?.type ?? 'local';

  switch (type) {
    case 'local':
      provider = createLocalEmbedding(embeddingConfig?.model);
      break;
    case 'openai': {
      if (!embeddingConfig?.apiKey) {
        throw new Error('OpenAI embedding 需要配置 apiKey');
      }
      provider = createOpenAIEmbedding(
        embeddingConfig.apiKey,
        embeddingConfig.model || 'text-embedding-3-small'
      );
      break;
    }
    default:
      throw new Error(`不支持的 embedding 类型: ${type}`);
  }

  return provider;
}

/**
 * Generate an embedding vector for the given text.
 * Results are cached in-memory (LRU, max 500 entries) for the lifetime of the process.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const key = hashText(text);
  const cached = embedCache.get(key);
  if (cached) return cached;
  const p = getEmbeddingProvider();
  const vector = await p.generate(text);
  embedCache.set(key, vector);
  return vector;
}

/**
 * Reset the cached provider (for testing or reconfiguration).
 */
export function resetEmbeddingProvider(): void {
  provider = null;
  embedCache.clear();
}
