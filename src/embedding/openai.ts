import type { EmbeddingProvider } from './index.js';

/**
 * OpenAI embedding provider using the REST API directly.
 * Default model: text-embedding-3-small (1536 dimensions).
 */
export function createOpenAIEmbedding(
  apiKey: string,
  model: string = 'text-embedding-3-small'
): EmbeddingProvider {
  return {
    async generate(text: string): Promise<number[]> {
      // Truncate very long text to avoid token limits
      const truncated = text.length > 8000 ? text.slice(0, 8000) : text;

      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          input: truncated,
          model,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenAI Embedding API 错误 (${response.status}): ${err}`);
      }

      const data = (await response.json()) as {
        data: Array<{ embedding: number[] }>;
      };
      return data.data[0].embedding;
    },
  };
}
