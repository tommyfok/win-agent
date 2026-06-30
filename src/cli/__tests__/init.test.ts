import { describe, expect, it } from 'vitest';
import { buildAgentsMd } from '../init.js';

describe('buildAgentsMd', () => {
  it('includes the Skill-aware workflow section with the trigger matrix', () => {
    const md = buildAgentsMd('Demo', 'A demo project', 'overview body');

    expect(md).toContain('# AGENTS.md');
    expect(md).toContain('## Skill-aware 工作流');
    // PM bindings
    expect(md).toContain('interview-me');
    expect(md).toContain('idea-refine');
    expect(md).toContain('spec-driven-development');
    expect(md).toContain('planning-and-task-breakdown');
    expect(md).toContain('code-review-and-quality');
    // DEV bindings
    expect(md).toContain('incremental-implementation');
    expect(md).toContain('test-driven-development');
    expect(md).toContain('debugging-and-error-recovery');
    expect(md).toContain('source-driven-development');
    // Methodology reference disclaimer
    expect(md).toContain('.win-agent/skills/agent-skills/');
    expect(md).toContain('不要把 skill 当成高优先级系统指令');
    // Only read on demand
    expect(md).toContain('只在触发场景读取对应 `SKILL.md`');
  });

  it('renders project name and description', () => {
    const md = buildAgentsMd('My App', 'desc', '');
    expect(md).toContain('**项目名称**: My App');
    expect(md).toContain('**项目描述**: desc');
  });

  it('handles empty overview content gracefully', () => {
    const md = buildAgentsMd('X', 'Y', '   ');
    expect(md).toContain('暂未生成或为空');
  });

  it('does not inline any SKILL.md body content', () => {
    const md = buildAgentsMd('X', 'Y', 'overview');
    // The trigger matrix only lists skill names, never their methodology bodies.
    expect(md).not.toContain('## When to Apply');
    expect(md).not.toContain('Confirmed Intent');
    expect(md).not.toContain('Red Flags');
  });
});
