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
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const p = getEmbeddingProvider();
  return p.generate(text);
}

/**
 * Reset the cached provider (for testing or reconfiguration).
 */
export function resetEmbeddingProvider(): void {
  provider = null;
}
