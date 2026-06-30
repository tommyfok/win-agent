import { beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb } from '../../db/__tests__/test-helpers.js';
import { insert } from '../../db/repository.js';
import { MessageStatus, TaskStatus } from '../../db/types.js';
import { MESSAGE_PROTOCOL } from '../message-protocol.js';
import { buildDispatchPrompt, getTaskContext } from '../prompt-builder.js';
import { Role } from '../role-manager.js';
import type { MessageRow } from '../dispatch-filter.js';

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

function createTask(
  title: string,
  status: TaskStatus,
  extras: { description?: string | null } = {}
): number {
  const { lastInsertRowid } = insert('tasks', { title, status, ...extras });
  return Number(lastInsertRowid);
}

describe('buildDispatchPrompt', () => {
  it('does not show stale DEV directives for done tasks in PM pending queue', () => {
    const doneTaskId = createTask('Done task', TaskStatus.Done);
    const activeTaskId = createTask('Active task', TaskStatus.InDev);

    insert('messages', {
      from_role: Role.PM,
      to_role: Role.DEV,
      type: 'directive',
      content: 'stale done directive',
      status: MessageStatus.Unread,
      related_task_id: doneTaskId,
    });
    insert('messages', {
      from_role: Role.PM,
      to_role: Role.DEV,
      type: 'directive',
      content: 'active directive',
      status: MessageStatus.Unread,
      related_task_id: activeTaskId,
    });

    const prompt = buildDispatchPrompt(Role.PM, [message()], [], null);

    expect(prompt).toContain('DEV 待处理队列（共 1 条未读）');
    expect(prompt).toContain('其他 task 共 1 条');
    expect(prompt).not.toContain('stale done directive');
  });

  it('shows structured message protocol attachments', () => {
    const prompt = buildDispatchPrompt(
      Role.DEV,
      [
        message({
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'directive',
          content: 'please implement feature',
          related_task_id: 123,
          attachments: JSON.stringify({
            protocol: MESSAGE_PROTOCOL,
            type: 'directive',
            task_id: 123,
            iteration_id: 7,
            spec_path: '.win-agent/docs/spec/demo.md',
          }),
        }),
      ],
      [],
      null
    );

    expect(prompt).toContain('please implement feature');
    expect(prompt).toContain('结构化消息 (protocol=win-agent.message.v1, type=directive');
    expect(prompt).toContain('task_id=123');
    expect(prompt).toContain('iteration_id=7');
    expect(prompt).toContain('"spec_path":".win-agent/docs/spec/demo.md"');
  });

  it('keeps non-protocol JSON and legacy messages visible', () => {
    const prompt = buildDispatchPrompt(
      Role.PM,
      [
        message({
          content: 'legacy content',
          attachments: JSON.stringify({ file: 'notes.txt', reason: 'legacy attachment' }),
        }),
        message({ id: 2, content: 'plain old message', attachments: null }),
      ],
      [],
      null
    );

    expect(prompt).toContain('legacy content');
    expect(prompt).toContain('attachments（非 win-agent.message.v1 协议 JSON，原样保留）');
    expect(prompt).toContain('"reason": "legacy attachment"');
    expect(prompt).toContain('plain old message');
  });

  it('does NOT embed the hardcoded Phase 1→4 workflow in DEV dispatch prompts', () => {
    const taskId = createTask('do something', TaskStatus.InDev);
    const prompt = buildDispatchPrompt(
      Role.DEV,
      [
        message({
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'directive',
          related_task_id: taskId,
        }),
      ],
      [],
      getTaskContext([
        message({
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'directive',
          related_task_id: taskId,
        }),
      ])
    );
    // The Phase 1→4 / subagent rules are recorded in DEV.md system prompt now,
    // not re-injected on every dispatch.
    expect(prompt).not.toContain('Phase 1 → 2 → 3 → 4');
    expect(prompt).not.toContain('禁止跳过');
    expect(prompt).not.toContain('执行要求');
    expect(prompt).not.toContain('Subagents 编排要求');
  });

  it('emits slim task-metadata block instead of echoing description / acceptance', () => {
    const taskId = createTask('Slim metadata task', TaskStatus.InDev, {
      description: 'full description that should NOT be echoed by dispatch prompt',
    });
    const ctx = getTaskContext([
      message({
        from_role: Role.PM,
        to_role: Role.DEV,
        type: 'directive',
        related_task_id: taskId,
      }),
    ]);
    const prompt = buildDispatchPrompt(
      Role.DEV,
      [
        message({
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'directive',
          content: 'pm directive body',
          related_task_id: taskId,
        }),
      ],
      [],
      ctx
    );
    expect(prompt).toContain(`## 任务元数据 (task#${taskId} · in_dev)`);
    expect(prompt).toContain('- 标题: Slim metadata task');
    expect(prompt).toContain('- 前置依赖: 无');
    expect(prompt).toContain('完整描述 / 验收标准 / 验收流程：见上方 PM directive 消息正文');
    // No echo of description from the task row itself
    expect(prompt).not.toContain('full description that should NOT be echoed');
    // No Feature Spec full-content block, no constitution block
    expect(prompt).not.toContain('## Feature Spec');
    expect(prompt).not.toContain('## 项目约束');
  });

  it('lists spec path under 可按需查阅 when task description references one', () => {
    const taskId = createTask('Has spec', TaskStatus.InDev, {
      description: '请实现 .win-agent/docs/spec/2026-06-foo.md 中的功能',
    });
    const ctx = getTaskContext([
      message({
        from_role: Role.PM,
        to_role: Role.DEV,
        type: 'directive',
        related_task_id: taskId,
      }),
    ]);
    const prompt = buildDispatchPrompt(
      Role.DEV,
      [
        message({
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'directive',
          related_task_id: taskId,
        }),
      ],
      [],
      ctx
    );
    expect(prompt).toContain('## 可按需查阅');
    expect(prompt).toContain('Spec: `.win-agent/docs/spec/2026-06-foo.md`');
    expect(prompt).toContain('用 Read 自取');
  });

  it('emits knowledge as an index (id pointer) instead of full content', () => {
    const taskId = createTask('with knowledge', TaskStatus.InDev);
    const ctx = getTaskContext([
      message({
        from_role: Role.PM,
        to_role: Role.DEV,
        type: 'directive',
        related_task_id: taskId,
      }),
    ]);
    const heavyContent = 'X'.repeat(5000);
    const prompt = buildDispatchPrompt(
      Role.DEV,
      [
        message({
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'directive',
          related_task_id: taskId,
        }),
      ],
      [
        {
          id: 42,
          title: 'Helpful guide',
          category: 'reference',
          content: heavyContent,
          tags: null,
        },
      ],
      ctx
    );
    expect(prompt).toContain('## 可按需查阅');
    expect(prompt).toContain('知识 [reference] Helpful guide');
    expect(prompt).toContain('`database_query knowledge id=42`');
    // The heavy content must NOT be inlined
    expect(prompt).not.toContain(heavyContent);
    expect(prompt).not.toContain('### Helpful guide');
  });

  it('truncates over-long handoff memory from completed dependencies', () => {
    const upstream = createTask('upstream', TaskStatus.Done);
    const current = createTask('current', TaskStatus.InDev);
    insert('task_dependencies', { task_id: current, depends_on: upstream });
    const longTail = 'Y'.repeat(2000);
    insert('memory', {
      role: 'DEV',
      trigger: 'task_complete',
      content: `task#${upstream} 完成：上游一句话摘要。${longTail}`,
      summary: `task#${upstream} 完成`,
    });

    const ctx = getTaskContext([
      message({
        from_role: Role.PM,
        to_role: Role.DEV,
        type: 'directive',
        related_task_id: current,
      }),
    ]);
    const prompt = buildDispatchPrompt(
      Role.DEV,
      [
        message({
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'directive',
          related_task_id: current,
        }),
      ],
      [],
      ctx
    );
    expect(prompt).toContain(`## 前置 task#${upstream} 关键产出`);
    expect(prompt).toContain('上游一句话摘要');
    expect(prompt).toContain('（完整内容见 memory 表）');
    // Most of the long tail must be cut
    expect(prompt).not.toContain(longTail);
  });
});

describe('buildDispatchPrompt — workflow hints', () => {
  it('injects a ## 工作流提示 section for a PM review_result dispatch', () => {
    const prompt = buildDispatchPrompt(
      Role.PM,
      [
        message({
          from_role: Role.DEV,
          to_role: Role.PM,
          type: 'review_result',
          content: '实现完成，附测试输出',
        }),
      ],
      [],
      null
    );
    expect(prompt).toContain('## 工作流提示');
    expect(prompt).toContain('code-review-and-quality');
    // PM's role-specific ## 提示 block must remain the last section.
    const hintIdx = prompt.indexOf('## 工作流提示\n');
    const tipIdx = prompt.indexOf('## 提示\n');
    expect(hintIdx).toBeGreaterThanOrEqual(0);
    expect(tipIdx).toBeGreaterThan(hintIdx);
  });

  it('omits ## 工作流提示 when no scenario matches', () => {
    const prompt = buildDispatchPrompt(
      Role.PM,
      [message({ from_role: Role.SYS, content: 'heartbeat ping' })],
      [],
      null
    );
    expect(prompt).not.toContain('## 工作流提示');
  });

  it('does not inline SKILL.md body content in the workflow-hints section', () => {
    const prompt = buildDispatchPrompt(
      Role.DEV,
      [
        message({
          from_role: Role.PM,
          to_role: Role.DEV,
          type: 'directive',
          content: '多文件重构 API 认证 接口 修复 bug 边界 迁移',
        }),
      ],
      [],
      null
    );
    expect(prompt).toContain('## 工作流提示');
    expect(prompt).not.toContain('## When to use');
    expect(prompt).not.toContain('Red Flags');
    expect(prompt).not.toContain('Steps');
  });
});

describe('getTaskContext', () => {
  it('returns slim shape: no description/acceptance/specContent/constitutionContent fields', () => {
    const taskId = createTask('shape test', TaskStatus.InDev, {
      description: 'with .win-agent/docs/spec/x.md inline',
    });
    const ctx = getTaskContext([
      message({
        from_role: Role.PM,
        to_role: Role.DEV,
        type: 'directive',
        related_task_id: taskId,
      }),
    ]);
    expect(ctx).not.toBeNull();
    expect(ctx).toEqual({
      id: taskId,
      title: 'shape test',
      status: TaskStatus.InDev,
      dependencies: [],
      specPath: '.win-agent/docs/spec/x.md',
    });
  });
});
