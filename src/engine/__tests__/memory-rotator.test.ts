import { describe, it, expect, beforeEach, vi } from 'vitest';

// memory-rotator.ts has module-level state (dynamicMaxContext, outputHistory).
// We reset modules before each test and re-initialize the DB in the fresh module context.
beforeEach(async () => {
  vi.resetModules();
  // Re-import helpers in the fresh module scope so the DB singleton is set correctly
  const { setupTestDb } = await import('../../db/__tests__/test-helpers.js');
  setupTestDb();
});

describe('recordOutputTokens / detectContextAnxiety (via checkAndRotate)', () => {
  it('does not trigger rotation when under threshold', async () => {
    const { checkAndRotate, detectModelContextLimit } = await import('../memory-rotator.js');

    const mockClient = {
      provider: {
        list: vi.fn().mockResolvedValue({
          data: { all: [{ models: { m: { limit: { context: 100_000 } } } }] },
        }),
      },
    };
    await detectModelContextLimit(mockClient as never);

    const mockSessionManager = { rotateSession: vi.fn().mockResolvedValue('new-session') };

    // 50% usage — below 80% threshold, no rotation
    const result = await checkAndRotate(
      mockSessionManager as never,
      'PM',
      'session-1',
      50_000,
      1000
    );

    expect(result).toBe('session-1');
    expect(mockSessionManager.rotateSession).not.toHaveBeenCalled();
  });

  it('triggers rotation when input tokens exceed 80% of context', async () => {
    const { checkAndRotate, detectModelContextLimit } = await import('../memory-rotator.js');

    const mockClient = {
      provider: {
        list: vi.fn().mockResolvedValue({
          data: { all: [{ models: { m: { limit: { context: 100_000 } } } }] },
        }),
      },
    };
    await detectModelContextLimit(mockClient as never);

    const mockSessionManager = { rotateSession: vi.fn().mockResolvedValue('new-session') };

    // 85% usage — exceeds 80% threshold
    const result = await checkAndRotate(
      mockSessionManager as never,
      'PM',
      'session-1',
      85_000,
      1000
    );

    expect(mockSessionManager.rotateSession).toHaveBeenCalledWith('PM', 'session-1', undefined);
    expect(result).toBe('new-session');
  });

  it('detects context anxiety when output tokens drop sharply at >50% usage', async () => {
    const { checkAndRotate, detectModelContextLimit, recordOutputTokens } = await import(
      '../memory-rotator.js'
    );

    const mockClient = {
      provider: {
        list: vi.fn().mockResolvedValue({
          data: { all: [{ models: { m: { limit: { context: 100_000 } } } }] },
        }),
      },
    };
    await detectModelContextLimit(mockClient as never);

    const mockSessionManager = { rotateSession: vi.fn().mockResolvedValue('new-session') };

    // Build history: 3 normal outputs averaging 1000 tokens
    recordOutputTokens('PM', 1000);
    recordOutputTokens('PM', 1000);
    recordOutputTokens('PM', 1000);

    // Sudden drop to 100 (10% of avg 1000). Anxiety threshold = 30% of 1000 = 300.
    // 100 < 300 → anxiety. Usage 60% > 50% minimum → triggers.
    const result = await checkAndRotate(
      mockSessionManager as never,
      'PM',
      'session-1',
      60_000,
      100
    );

    expect(mockSessionManager.rotateSession).toHaveBeenCalled();
    expect(result).toBe('new-session');
  });

  it('does not trigger anxiety when history is insufficient (< 3 outputs)', async () => {
    const { checkAndRotate, detectModelContextLimit, recordOutputTokens } = await import(
      '../memory-rotator.js'
    );

    const mockClient = {
      provider: {
        list: vi.fn().mockResolvedValue({
          data: { all: [{ models: { m: { limit: { context: 100_000 } } } }] },
        }),
      },
    };
    await detectModelContextLimit(mockClient as never);

    const mockSessionManager = { rotateSession: vi.fn().mockResolvedValue('new-session') };

    // Only 2 history entries — below the 3-entry minimum
    recordOutputTokens('PM', 1000);
    recordOutputTokens('PM', 1000);

    const result = await checkAndRotate(
      mockSessionManager as never,
      'PM',
      'session-1',
      60_000,
      10 // dramatic drop, but insufficient history
    );

    expect(mockSessionManager.rotateSession).not.toHaveBeenCalled();
    expect(result).toBe('session-1');
  });

  it('does not trigger anxiety when usage is below 50%', async () => {
    const { checkAndRotate, detectModelContextLimit, recordOutputTokens } = await import(
      '../memory-rotator.js'
    );

    const mockClient = {
      provider: {
        list: vi.fn().mockResolvedValue({
          data: { all: [{ models: { m: { limit: { context: 100_000 } } } }] },
        }),
      },
    };
    await detectModelContextLimit(mockClient as never);

    const mockSessionManager = { rotateSession: vi.fn().mockResolvedValue('new-session') };

    recordOutputTokens('PM', 1000);
    recordOutputTokens('PM', 1000);
    recordOutputTokens('PM', 1000);

    // Dramatic drop but usage only 40% — anxiety check skipped at <50%
    const result = await checkAndRotate(
      mockSessionManager as never,
      'PM',
      'session-1',
      40_000,
      10
    );

    expect(mockSessionManager.rotateSession).not.toHaveBeenCalled();
    expect(result).toBe('session-1');
  });
});

describe('loadOutputHistory / saveOutputHistory (P1-3 persistence)', () => {
  it('recordOutputTokens persists history to project_config', async () => {
    const { recordOutputTokens } = await import('../memory-rotator.js');
    const { select } = await import('../../db/repository.js');

    recordOutputTokens('PM', 1234);

    const rows = select<{ value: string }>('project_config', { key: 'engine.outputHistory.PM' });
    expect(rows.length).toBe(1);
    const stored = JSON.parse(rows[0].value) as number[];
    expect(stored).toContain(1234);
  });

  it('loadOutputHistory restores outputHistory from project_config', async () => {
    const { upsertProjectConfig } = await import('../../db/repository.js');
    // Seed 3 large outputs so anxiety detection can trigger
    upsertProjectConfig('engine.outputHistory.PM', JSON.stringify([1000, 1000, 1000]));

    const { loadOutputHistory, checkAndRotate, detectModelContextLimit } = await import(
      '../memory-rotator.js'
    );

    const mockClient = {
      provider: {
        list: vi.fn().mockResolvedValue({
          data: { all: [{ models: { m: { limit: { context: 100_000 } } } }] },
        }),
      },
    };
    await detectModelContextLimit(mockClient as never);

    // Load history from DB — now PM has [1000, 1000, 1000] in memory
    loadOutputHistory();

    const mockSessionManager = { rotateSession: vi.fn().mockResolvedValue('new-session') };

    // Output of 50 is well below 30% of avg 1000 → context anxiety should trigger at 60% usage
    const result = await checkAndRotate(
      mockSessionManager as never,
      'PM',
      'session-1',
      60_000,
      50
    );

    expect(mockSessionManager.rotateSession).toHaveBeenCalled();
    expect(result).toBe('new-session');
  });

  it('loadOutputHistory is a no-op when project_config has no history keys', async () => {
    const { loadOutputHistory, checkAndRotate, detectModelContextLimit } = await import(
      '../memory-rotator.js'
    );

    const mockClient = {
      provider: {
        list: vi.fn().mockResolvedValue({
          data: { all: [{ models: { m: { limit: { context: 100_000 } } } }] },
        }),
      },
    };
    await detectModelContextLimit(mockClient as never);
    loadOutputHistory(); // no-op — nothing in DB

    const mockSessionManager = { rotateSession: vi.fn().mockResolvedValue('new-session') };

    // Same dramatic drop, but history is empty — anxiety check skipped (insufficient history)
    const result = await checkAndRotate(
      mockSessionManager as never,
      'PM',
      'session-1',
      60_000,
      50
    );

    expect(mockSessionManager.rotateSession).not.toHaveBeenCalled();
    expect(result).toBe('session-1');
  });
});
