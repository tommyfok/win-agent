import { describe, it, expect } from 'vitest';
import { parseGoModelsFromCli, parseGoModelsFromProviders } from '../check.js';

describe('parseGoModelsFromCli', () => {
  it('parses opencode-go models from CLI output', () => {
    const output = `opencode/big-pickle
opencode/claude-sonnet-4-6
opencode-go/glm-5
opencode-go/glm-5.1
opencode-go/kimi-k2.5
alibaba-coding-plan-cn/qwen3.6-plus
`;
    const models = parseGoModelsFromCli(output);
    expect(models).toEqual(['glm-5', 'glm-5.1', 'kimi-k2.5']);
  });

  it('returns empty array when no opencode-go models present', () => {
    const output = `opencode/claude-sonnet-4-6
alibaba-coding-plan-cn/qwen3.6-plus
`;
    const models = parseGoModelsFromCli(output);
    expect(models).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(parseGoModelsFromCli('')).toEqual([]);
    expect(parseGoModelsFromCli('\n\n')).toEqual([]);
  });

  it('handles mixed whitespace and sorts results', () => {
    const output = `  opencode-go/minimax-m2.7  
opencode-go/glm-5
  opencode-go/kimi-k2.5
`;
    const models = parseGoModelsFromCli(output);
    expect(models).toEqual(['glm-5', 'kimi-k2.5', 'minimax-m2.7']);
  });

  it('ignores lines that contain opencode-go but do not start with it', () => {
    const output = `some-opencode-go/fake-model
opencode-go/real-model
not-opencode-go/another-fake
`;
    const models = parseGoModelsFromCli(output);
    expect(models).toEqual(['real-model']);
  });
});

describe('parseGoModelsFromProviders', () => {
  it('parses opencode-go models from providers response', () => {
    const body = {
      providers: [
        {
          id: 'opencode',
          models: { 'claude-sonnet-4-6': { id: 'claude-sonnet-4-6' } },
        },
        {
          id: 'opencode-go',
          models: {
            'glm-5': { id: 'glm-5' },
            'kimi-k2.5': { id: 'kimi-k2.5' },
            'minimax-m2.7': { id: 'minimax-m2.7' },
          },
        },
      ],
    };
    const models = parseGoModelsFromProviders(body as never);
    expect(models).toEqual(['glm-5', 'kimi-k2.5', 'minimax-m2.7']);
  });

  it('returns empty array when opencode-go provider not found', () => {
    const body = {
      providers: [
        {
          id: 'opencode',
          models: { 'claude-sonnet-4-6': { id: 'claude-sonnet-4-6' } },
        },
      ],
    };
    const models = parseGoModelsFromProviders(body as never);
    expect(models).toEqual([]);
  });

  it('returns empty array when providers array is missing', () => {
    const models = parseGoModelsFromProviders({} as never);
    expect(models).toEqual([]);
  });

  it('returns empty array when opencode-go has no models', () => {
    const body = {
      providers: [
        {
          id: 'opencode-go',
        },
      ],
    };
    const models = parseGoModelsFromProviders(body as never);
    expect(models).toEqual([]);
  });

  it('returns empty array when models is empty object', () => {
    const body = {
      providers: [
        {
          id: 'opencode-go',
          models: {},
        },
      ],
    };
    const models = parseGoModelsFromProviders(body as never);
    expect(models).toEqual([]);
  });
});
