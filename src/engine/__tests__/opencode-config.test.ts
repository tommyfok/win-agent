import { describe, it, expect } from 'vitest';
import { buildOpencodeConfig } from '../opencode-config.js';
import type { ProviderConfig } from '../../config/index.js';

describe('buildOpencodeConfig', () => {
  describe('built-in providers (anthropic, openai)', () => {
    it('builds correct config for anthropic provider', () => {
      const provider: ProviderConfig = {
        type: 'anthropic',
        apiKey: 'sk-ant-test-key',
        model: 'claude-sonnet-4-20250514',
      };

      const config = buildOpencodeConfig(provider);

      expect(config.model).toBe('anthropic/claude-sonnet-4-20250514');
      expect(config.provider).toEqual({
        anthropic: {
          env: ['ANTHROPIC_API_KEY=sk-ant-test-key'],
        },
      });
      expect(config.permission).toEqual({ edit: 'allow', bash: 'allow' });
    });

    it('builds correct config for openai provider', () => {
      const provider: ProviderConfig = {
        type: 'openai',
        apiKey: 'sk-openai-test-key',
        model: 'gpt-4o',
      };

      const config = buildOpencodeConfig(provider);

      expect(config.model).toBe('openai/gpt-4o');
      expect(config.provider).toEqual({
        openai: {
          env: ['OPENAI_API_KEY=sk-openai-test-key'],
        },
      });
    });

    it('omits env when apiKey is empty', () => {
      const provider: ProviderConfig = {
        type: 'anthropic',
        apiKey: '',
        model: 'claude-sonnet-4-20250514',
      };

      const config = buildOpencodeConfig(provider);

      expect(config.provider).toEqual({ anthropic: {} });
    });
  });

  describe('custom providers (custom-openai, custom-anthropic)', () => {
    it('builds correct config for custom-openai provider', () => {
      const provider: ProviderConfig = {
        type: 'custom-openai',
        apiKey: 'custom-key',
        model: 'my-model',
        baseUrl: 'https://api.example.com/v1',
      };

      const config = buildOpencodeConfig(provider);

      expect(config.model).toBe('custom/my-model');
      expect(config.provider).toEqual({
        custom: {
          npm: '@ai-sdk/openai-compatible',
          models: {
            'my-model': {
              name: 'my-model',
              tool_call: true,
            },
          },
          options: {
            baseURL: 'https://api.example.com/v1',
            apiKey: 'custom-key',
          },
        },
      });
    });

    it('builds correct config for custom-anthropic provider', () => {
      const provider: ProviderConfig = {
        type: 'custom-anthropic',
        apiKey: 'custom-ant-key',
        model: 'my-claude',
        baseUrl: 'https://proxy.example.com/v1',
      };

      const config = buildOpencodeConfig(provider);

      expect(config.model).toBe('custom/my-claude');
      expect(config.provider).toEqual({
        custom: {
          npm: '@ai-sdk/anthropic',
          models: {
            'my-claude': {
              name: 'my-claude',
              tool_call: true,
            },
          },
          options: {
            baseURL: 'https://proxy.example.com/v1',
            apiKey: 'custom-ant-key',
          },
        },
      });
    });

    it('includes reasoning flag for custom-openai reasoning model', () => {
      const provider: ProviderConfig = {
        type: 'custom-openai',
        apiKey: 'key',
        model: 'deepseek-r1',
        baseUrl: 'https://api.deepseek.com/v1',
        reasoning: true,
      };

      const config = buildOpencodeConfig(provider);

      expect(config.provider).toEqual({
        custom: {
          npm: '@ai-sdk/openai-compatible',
          models: {
            'deepseek-r1': {
              name: 'deepseek-r1',
              tool_call: true,
              reasoning: true,
            },
          },
          options: {
            baseURL: 'https://api.deepseek.com/v1',
            apiKey: 'key',
          },
        },
      });
    });

    it('omits baseURL when not provided', () => {
      const provider: ProviderConfig = {
        type: 'custom-openai',
        apiKey: 'key',
        model: 'model',
      };

      const config = buildOpencodeConfig(provider);

      const custom = (config.provider as Record<string, { options: Record<string, string> }>)[
        'custom'
      ];
      expect(custom.options).toEqual({ apiKey: 'key' });
    });
  });

  describe('OpenCode Zen provider', () => {
    it('builds correct config for opencode-zen with Claude model', () => {
      const provider: ProviderConfig = {
        type: 'opencode-zen',
        apiKey: 'zen-api-key-123',
        model: 'claude-sonnet-4-6',
      };

      const config = buildOpencodeConfig(provider);

      expect(config.model).toBe('opencode/claude-sonnet-4-6');
      expect(config.provider).toEqual({
        opencode: {
          env: ['OPENCODE_API_KEY=zen-api-key-123'],
        },
      });
      expect(config.permission).toEqual({ edit: 'allow', bash: 'allow' });
    });

    it('builds correct config for opencode-zen with GPT model', () => {
      const provider: ProviderConfig = {
        type: 'opencode-zen',
        apiKey: 'zen-key',
        model: 'gpt-5.3-codex',
      };

      const config = buildOpencodeConfig(provider);

      expect(config.model).toBe('opencode/gpt-5.3-codex');
      expect(config.provider).toEqual({
        opencode: {
          env: ['OPENCODE_API_KEY=zen-key'],
        },
      });
    });

    it('builds correct config for opencode-zen with Gemini model', () => {
      const provider: ProviderConfig = {
        type: 'opencode-zen',
        apiKey: 'zen-key',
        model: 'gemini-3.1-pro',
      };

      const config = buildOpencodeConfig(provider);

      expect(config.model).toBe('opencode/gemini-3.1-pro');
    });

    it('omits provider env when apiKey is empty', () => {
      const provider: ProviderConfig = {
        type: 'opencode-zen',
        apiKey: '',
        model: 'claude-sonnet-4-6',
      };

      const config = buildOpencodeConfig(provider);

      expect(config.model).toBe('opencode/claude-sonnet-4-6');
      expect(config.provider).toEqual({});
    });
  });

  describe('OpenCode Go provider', () => {
    it('builds correct config for opencode-go with GLM model', () => {
      const provider: ProviderConfig = {
        type: 'opencode-go',
        apiKey: 'go-api-key-456',
        model: 'glm-5.1',
      };

      const config = buildOpencodeConfig(provider);

      expect(config.model).toBe('opencode-go/glm-5.1');
      expect(config.provider).toEqual({
        'opencode-go': {
          env: ['OPENCODE_API_KEY=go-api-key-456'],
        },
      });
      expect(config.permission).toEqual({ edit: 'allow', bash: 'allow' });
    });

    it('builds correct config for opencode-go with Kimi model', () => {
      const provider: ProviderConfig = {
        type: 'opencode-go',
        apiKey: 'go-key',
        model: 'kimi-k2.5',
      };

      const config = buildOpencodeConfig(provider);

      expect(config.model).toBe('opencode-go/kimi-k2.5');
      expect(config.provider).toEqual({
        'opencode-go': {
          env: ['OPENCODE_API_KEY=go-key'],
        },
      });
    });

    it('builds correct config for opencode-go with Qwen model', () => {
      const provider: ProviderConfig = {
        type: 'opencode-go',
        apiKey: 'go-key',
        model: 'qwen3.6-plus',
      };

      const config = buildOpencodeConfig(provider);

      expect(config.model).toBe('opencode-go/qwen3.6-plus');
    });

    it('omits provider env when apiKey is empty', () => {
      const provider: ProviderConfig = {
        type: 'opencode-go',
        apiKey: '',
        model: 'glm-5',
      };

      const config = buildOpencodeConfig(provider);

      expect(config.model).toBe('opencode-go/glm-5');
      expect(config.provider).toEqual({});
    });
  });

  describe('provider type routing', () => {
    it('does not treat opencode-zen as a custom provider', () => {
      const provider: ProviderConfig = {
        type: 'opencode-zen',
        apiKey: 'key',
        model: 'claude-sonnet-4-6',
      };

      const config = buildOpencodeConfig(provider);

      // Should NOT have custom/<model> format
      expect(config.model).not.toContain('custom/');
      expect(config.model).toBe('opencode/claude-sonnet-4-6');
    });

    it('does not treat opencode-go as a custom provider', () => {
      const provider: ProviderConfig = {
        type: 'opencode-go',
        apiKey: 'key',
        model: 'glm-5.1',
      };

      const config = buildOpencodeConfig(provider);

      expect(config.model).not.toContain('custom/');
      expect(config.model).toBe('opencode-go/glm-5.1');
    });

    it('does not treat opencode-zen as a built-in anthropic/openai provider', () => {
      const provider: ProviderConfig = {
        type: 'opencode-zen',
        apiKey: 'key',
        model: 'claude-sonnet-4-6',
      };

      const config = buildOpencodeConfig(provider);

      // Should use OPENCODE_API_KEY, not OPENCODE-ZEN_API_KEY
      const providerConfig = config.provider as Record<string, { env?: string[] }>;
      expect(providerConfig['opencode']?.env?.[0]).toBe('OPENCODE_API_KEY=key');
    });
  });
});
