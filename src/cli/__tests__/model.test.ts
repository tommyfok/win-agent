import { describe, it, expect } from 'vitest';
import { parseOpencodeModels } from '../model.js';

describe('parseOpencodeModels', () => {
  it('parses provider/model pairs from CLI output', () => {
    const output = `opencode/claude-sonnet-4-6
opencode/gpt-5
opencode-go/glm-5
opencode-go/kimi-k2.5
alibaba-coding-plan-cn/qwen3.6-plus
`;
    const models = parseOpencodeModels(output);

    expect(models.size).toBe(3);
    expect(models.get('opencode')).toEqual(['claude-sonnet-4-6', 'gpt-5']);
    expect(models.get('opencode-go')).toEqual(['glm-5', 'kimi-k2.5']);
    expect(models.get('alibaba-coding-plan-cn')).toEqual(['qwen3.6-plus']);
  });

  it('returns empty map for empty input', () => {
    expect(parseOpencodeModels('').size).toBe(0);
    expect(parseOpencodeModels('\n\n').size).toBe(0);
  });

  it('ignores lines without slash', () => {
    const output = `invalid-line
opencode/gpt-5
another-invalid
`;
    const models = parseOpencodeModels(output);
    expect(models.size).toBe(1);
    expect(models.get('opencode')).toEqual(['gpt-5']);
  });

  it('handles mixed whitespace and trims lines', () => {
    const output = `  opencode/claude-sonnet-4-6  
  opencode-go/glm-5
   opencode/gpt-5   
`;
    const models = parseOpencodeModels(output);

    expect(models.size).toBe(2);
    expect(models.get('opencode')).toEqual(['claude-sonnet-4-6', 'gpt-5']);
    expect(models.get('opencode-go')).toEqual(['glm-5']);
  });

  it('sorts models within each provider', () => {
    const output = `provider/z-model
provider/a-model
provider/m-model
`;
    const models = parseOpencodeModels(output);
    expect(models.get('provider')).toEqual(['a-model', 'm-model', 'z-model']);
  });

  it('handles model names with multiple slashes', () => {
    const output = `provider/model/name/with/slashes
provider/another-model
`;
    const models = parseOpencodeModels(output);
    expect(models.get('provider')).toEqual(['another-model', 'model/name/with/slashes']);
  });

  it('handles real-world opencode models output', () => {
    const output = `opencode/big-pickle
opencode/claude-3-5-haiku
opencode/claude-haiku-4-5
opencode-go/glm-5
opencode-go/glm-5.1
opencode-go/kimi-k2.5
alibaba-coding-plan-cn/qwen3.6-plus
tencent-coding-plan-cn/hunyuan
`;
    const models = parseOpencodeModels(output);

    expect(models.size).toBe(4);
    expect(models.get('opencode')!.length).toBe(3);
    expect(models.get('opencode-go')!.length).toBe(3);
    expect(models.get('alibaba-coding-plan-cn')).toEqual(['qwen3.6-plus']);
    expect(models.get('tencent-coding-plan-cn')).toEqual(['hunyuan']);
  });
});
