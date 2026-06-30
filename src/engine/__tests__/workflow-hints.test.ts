import { beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb } from '../../db/__tests__/test-helpers.js';
import { MessageStatus } from '../../db/types.js';
import type { MessageRow } from '../dispatch-filter.js';
import { Role } from '../role-manager.js';
import type { TaskContext } from '../prompt-builder.js';
import {
  selectWorkflowHints,
  containsAnyKeyword,
  DEV_FAILURE_KEYWORDS,
} from '../workflow-hints.js';

beforeEach(() => {
  setupTestDb();
});

function message(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 1,
    from_role: Role.USER,
    to_role: Role.PM,
    type: 'system',
    content: 'user ping',
    status: MessageStatus.Unread,
    related_task_id: null,
    related_iteration_id: null,
    attachments: null,
    created_at: '',
    retry_count: 0,
    last_retry_at: null,
    ...overrides,
  };
}

function ctx(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    id: 1,
    title: 'task title',
    status: 'in_dev',
    dependencies: [],
    specPath: null,
    ...overrides,
  };
}

describe('selectWorkflowHints — PM', () => {
  it('hints intent → idea → spec order for a USER new-requirement with no spec', () => {
    const hints = selectWorkflowHints(
      Role.PM,
      [message({ content: '我想做一个自动周报功能' })],
      null
    );
    expect(hints.length).toBeGreaterThan(0);
    const line = hints.join('\n');
    expect(line).toContain('interview-me');
    expect(line).toContain('idea-refine');
    expect(line).toContain('spec-driven-development');
  });

  it('hints code-review-and-quality when DEV sends a review_result', () => {
    const hints = selectWorkflowHints(
      Role.PM,
      [
        message({
          from_role: Role.DEV,
          to_role: Role.PM,
          type: 'review_result',
          content: '实现完成，附测试输出',
        }),
      ],
      null
    );
    expect(hints.some((h) => h.includes('code-review-and-quality'))).toBe(true);
  });

  it('suppresses the intent/spec hint when taskContext already carries a specPath', () => {
    const hints = selectWorkflowHints(
      Role.PM,
      [message({ content: '实现周报功能' })],
      ctx({ specPath: '.win-agent/docs/spec/2026-06-weekly.md' })
    );
    // No USER new-requirement hint, and no DEV review_result either → empty.
    expect(hints).toHaveLength(0);
  });

  it('suppresses the intent/spec hint when message content already references a spec', () => {
    const hints = selectWorkflowHints(
      Role.PM,
      [message({ content: '请按 .win-agent/docs/spec/2026-06-weekly.md 实现' })],
      null
    );
    expect(hints.some((h) => h.includes('interview-me'))).toBe(false);
    expect(hints.some((h) => h.includes('spec-driven-development'))).toBe(false);
  });

  it('returns [] for a non-requirement system ping (no USER, no DEV review)', () => {
    const hints = selectWorkflowHints(
      Role.PM,
      [message({ from_role: Role.SYS, content: 'heartbeat' })],
      null
    );
    expect(hints).toHaveLength(0);
  });
});

describe('selectWorkflowHints — DEV', () => {
  it('hints debugging-and-error-recovery for PM feedback with failure keywords', () => {
    const hints = selectWorkflowHints(
      Role.DEV,
      [
        message({
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'feedback',
          content: 'lint 报错，build 失败，打回重做',
        }),
      ],
      null
    );
    expect(hints.some((h) => h.includes('debugging-and-error-recovery'))).toBe(true);
  });

  it('does not hint debugging for PM feedback without failure keywords', () => {
    const hints = selectWorkflowHints(
      Role.DEV,
      [
        message({
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'feedback',
          content: '整体不错，继续推进',
        }),
      ],
      null
    );
    expect(hints.some((h) => h.includes('debugging-and-error-recovery'))).toBe(false);
  });

  it('hints api-and-interface-design and security-and-hardening for API/auth directives', () => {
    const hints = selectWorkflowHints(
      Role.DEV,
      [
        message({
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'directive',
          content: '实现登录认证 API 接口',
        }),
      ],
      null
    );
    expect(hints.some((h) => h.includes('api-and-interface-design'))).toBe(true);
    expect(hints.some((h) => h.includes('security-and-hardening'))).toBe(true);
  });

  it('hints test-driven-development for bug-fix directives', () => {
    const hints = selectWorkflowHints(
      Role.DEV,
      [
        message({
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'directive',
          content: '修复登录 bug 的边界情况',
        }),
      ],
      null
    );
    expect(hints.some((h) => h.includes('test-driven-development'))).toBe(true);
  });

  it('hints incremental-implementation for multi-file / refactor directives', () => {
    const hints = selectWorkflowHints(
      Role.DEV,
      [
        message({
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'directive',
          content: '多文件重构，迁移旧模块',
        }),
      ],
      null
    );
    expect(hints.some((h) => h.includes('incremental-implementation'))).toBe(true);
  });

  it('also matches directive keywords in the task title via taskContext', () => {
    const hints = selectWorkflowHints(
      Role.DEV,
      [
        message({
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'directive',
          content: '请实现该功能',
        }),
      ],
      ctx({ title: '上传文件接口 API' })
    );
    expect(hints.some((h) => h.includes('api-and-interface-design'))).toBe(true);
    expect(hints.some((h) => h.includes('security-and-hardening'))).toBe(true);
  });
});

describe('selectWorkflowHints — output shape', () => {
  it('never inlines SKILL.md body markers', () => {
    const scenarios: Array<{ role: Role; messages: MessageRow[]; ctx: TaskContext | null }> = [
      {
        role: Role.PM,
        messages: [message({ content: '我想做一个新功能' })],
        ctx: null,
      },
      {
        role: Role.PM,
        messages: [
          message({
            from_role: Role.DEV,
            to_role: Role.PM,
            type: 'review_result',
            content: '完成',
          }),
        ],
        ctx: null,
      },
      {
        role: Role.DEV,
        messages: [
          message({
            from_role: Role.PM,
            to_role: Role.DEV,
            type: 'directive',
            content: '多文件重构 API 认证 接口 修复 bug 边界 迁移',
          }),
        ],
        ctx: null,
      },
      {
        role: Role.DEV,
        messages: [
          message({
            from_role: Role.PM,
            to_role: Role.DEV,
            type: 'feedback',
            content: 'test 报错 build 失败',
          }),
        ],
        ctx: null,
      },
    ];
    for (const s of scenarios) {
      const hints = selectWorkflowHints(s.role, s.messages, s.ctx);
      const joined = hints.join('\n');
      expect(joined).not.toContain('## When to use');
      expect(joined).not.toContain('Red Flags');
      expect(joined).not.toContain('Steps');
      // Every emitted hint references a SKILL.md path and the skill base dir.
      for (const h of hints) {
        expect(h).toContain('SKILL.md');
        expect(h).toContain('.win-agent/skills/agent-skills/skills/');
        expect(h.startsWith('- ')).toBe(true);
      }
    }
  });

  it('keeps hint count within 8 lines even for a keyword-heavy dispatch', () => {
    const hints = selectWorkflowHints(
      Role.DEV,
      [
        message({
          id: 1,
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'feedback',
          content: 'lint 报错 build 失败',
        }),
        message({
          id: 2,
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'directive',
          content: '多文件重构 API 认证 接口 修复 bug 边界 迁移',
        }),
      ],
      null
    );
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.length).toBeLessThanOrEqual(8);
    // No duplicate lines.
    expect(new Set(hints).size).toBe(hints.length);
  });

  it('returns [] for empty messages', () => {
    expect(selectWorkflowHints(Role.PM, [], null)).toEqual([]);
    expect(selectWorkflowHints(Role.DEV, [], null)).toEqual([]);
  });

  it('containsAnyKeyword is case-insensitive', () => {
    expect(containsAnyKeyword('please fix the API', DEV_FAILURE_KEYWORDS)).toBe(false);
    expect(containsAnyKeyword('BUILD failed', DEV_FAILURE_KEYWORDS)).toBe(true);
    expect(containsAnyKeyword('Lint Error', DEV_FAILURE_KEYWORDS)).toBe(true);
  });
});
