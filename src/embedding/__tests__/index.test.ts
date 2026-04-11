import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared spy so all calls to the mocked provider use the same reference
const mockGenerate = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);

vi.mock('../local.js', () => ({
  createLocalEmbedding: () => ({ generate: mockGenerate }),
}));

vi.mock('../../config/index.js', () => ({
  loadConfig: () => ({ embedding: { type: 'local' } }),
}));

// Import after mocks are set up
const { generateEmbedding, resetEmbeddingProvider } = await import('../index.js');

beforeEach(() => {
  mockGenerate.mockClear();
  resetEmbeddingProvider();
});

describe('generateEmbedding LRU cache', () => {
  it('returns the same vector for the same text without calling provider twice', async () => {
    const v1 = await generateEmbedding('hello world');
    const v2 = await generateEmbedding('hello world');

    expect(v1).toEqual([0.1, 0.2, 0.3]);
    expect(v2).toEqual([0.1, 0.2, 0.3]);
    // Provider should only have been called once; second call is served from cache
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it('calls provider for different texts', async () => {
    await generateEmbedding('text one');
    await generateEmbedding('text two');

    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });

  it('cache is cleared after resetEmbeddingProvider', async () => {
    await generateEmbedding('hello');
    resetEmbeddingProvider();
    await generateEmbedding('hello');

    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });
});
