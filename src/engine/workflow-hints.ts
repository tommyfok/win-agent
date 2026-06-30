import type { MessageRow } from './dispatch-filter.js';
import { Role } from './role-manager.js';
import type { TaskContext } from './prompt-builder.js';

/**
 * Lightweight workflow hints injected into dispatch prompts.
 *
 * Design (see docs/agent-skills-workflow-adoption-plan.md § "dispatch prompt 增强"):
 *   - Returns a SHORT checklist (≤ 8 lines) reminding the role which skill to READ.
 *   - Never inlines SKILL.md body content — only skill name, path, and the required
 *     artifact / gate.
 *   - Does not duplicate the full PM.md / DEV.md flow already in role system prompts.
 *   - Returns [] when no scenario matches, so the prompt section is omitted entirely.
 */

const SKILLS_BASE = '.win-agent/skills/agent-skills/skills';

/** Hard cap on returned hint lines (the section header is added by the caller). */
const HINT_CAP = 8;

/** Matches a spec path referenced anywhere in message content. */
const SPEC_PATH_REGEX = /\.win-agent\/docs\/spec\//i;

/**
 * Failure keywords that, when present in PM→DEV feedback, signal the DEV should
 * follow the debugging-and-error-recovery workflow.
 */
export const DEV_FAILURE_KEYWORDS = [
  'test',
  'build',
  'lint',
  'error',
  '失败',
  '报错',
  '打回',
  '不通过',
] as const;

/** Keywords indicating an API / interface design concern on a DEV directive. */
export const DEV_API_KEYWORDS = ['api', '接口'] as const;

/** Keywords indicating a security / hardening concern on a DEV directive. */
export const DEV_SECURITY_KEYWORDS = [
  'auth',
  'permission',
  'upload',
  '权限',
  '上传',
  '数据存储',
  '认证',
  '鉴权',
] as const;

/** Keywords hinting a multi-file / large task (kept conservative to avoid noise). */
export const DEV_MULTIFILE_KEYWORDS = ['多文件', '重构', '迁移'] as const;

/** Keywords hinting new behavior / bug fix that needs test evidence. */
export const DEV_BUGFIX_KEYWORDS = ['新行为', 'bug', '修复', '边界'] as const;

/**
 * Case-insensitive substring match. Returns true if `haystack` contains any of the
 * provided keywords. Exported so tests can assert keyword behavior directly.
 */
export function containsAnyKeyword(haystack: string, keywords: readonly string[]): boolean {
  if (!haystack) return false;
  const lower = haystack.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

/**
 * Select short workflow hint lines for a dispatch prompt.
 *
 * @param role         The role receiving the dispatch (PM or DEV).
 * @param messages     The messages delivered in this dispatch.
 * @param taskContext  Optional task context (id/title/status/deps/specPath).
 * @returns Hint lines (each one line). Empty when no scenario matches.
 */
export function selectWorkflowHints(
  role: Role,
  messages: MessageRow[],
  taskContext?: TaskContext | null
): string[] {
  if (!messages || messages.length === 0) return [];
  const hints: string[] = [];

  if (role === Role.PM) {
    selectPmHints(messages, taskContext ?? null, hints);
  } else if (role === Role.DEV) {
    selectDevHints(messages, taskContext ?? null, hints);
  }

  return dedupeAndCap(hints);
}

function selectPmHints(
  messages: MessageRow[],
  taskContext: TaskContext | null,
  hints: string[]
): void {
  const hasSpec = Boolean(taskContext?.specPath);

  // 1. New requirement from USER with no spec yet → intent → idea → spec judgment order.
  if (!hasSpec) {
    const newUserMsg = messages.find(
      (m) =>
        m.from_role === Role.USER &&
        m.type !== 'review_result' &&
        !SPEC_PATH_REGEX.test(m.content || '')
    );
    if (newUserMsg) {
      hints.push(
        `- 新需求意图不清：按序判断 interview-me → idea-refine → spec-driven-development` +
          `（${SKILLS_BASE}/ 下各 SKILL.md），产出 Confirmed Intent / Idea One-pager / Feature Spec`
      );
    }
  }

  // 2. DEV review_result → audit evidence against acceptance criteria.
  const hasReview = messages.some((m) => m.from_role === Role.DEV && m.type === 'review_result');
  if (hasReview) {
    hints.push(
      `- 收到 DEV review_result：读取 ${SKILLS_BASE}/code-review-and-quality/SKILL.md，` +
        `逐条验收标准绑定证据`
    );
  }
}

function selectDevHints(
  messages: MessageRow[],
  taskContext: TaskContext | null,
  hints: string[]
): void {
  const taskTitle = taskContext?.title || '';

  // 1. PM feedback carrying failure keywords → debugging-and-error-recovery.
  const feedbackMsg = messages.find((m) => m.from_role === Role.PM && m.type === 'feedback');
  if (feedbackMsg && containsAnyKeyword(feedbackMsg.content || '', DEV_FAILURE_KEYWORDS)) {
    hints.push(
      `- PM feedback 含失败信息：读取 ${SKILLS_BASE}/debugging-and-error-recovery/SKILL.md，` +
        `记录 复现/根因/修复/回归`
    );
  }

  // 2-4. PM directive → inspect content (+ task title) for skill-relevant signals.
  const directiveMsgs = messages.filter((m) => m.from_role === Role.PM && m.type === 'directive');
  if (directiveMsgs.length > 0) {
    const combined = directiveMsgs.map((m) => m.content || '').join('\n');
    const hay = `${combined}\n${taskTitle}`;

    if (containsAnyKeyword(hay, DEV_API_KEYWORDS)) {
      hints.push(
        `- 涉及 API/接口设计：读取 ${SKILLS_BASE}/api-and-interface-design/SKILL.md，产出接口契约`
      );
    }
    if (containsAnyKeyword(hay, DEV_SECURITY_KEYWORDS)) {
      hints.push(
        `- 涉及认证/鉴权/权限/数据存储：读取 ${SKILLS_BASE}/security-and-hardening/SKILL.md，` +
          `做安全检查`
      );
    }
    if (containsAnyKeyword(hay, DEV_BUGFIX_KEYWORDS)) {
      hints.push(
        `- 新行为/bug/修复：读取 ${SKILLS_BASE}/test-driven-development/SKILL.md，产出 Test Evidence`
      );
    }
    // Conservative: only when the task explicitly signals large/multi-file scope.
    if (containsAnyKeyword(hay, DEV_MULTIFILE_KEYWORDS)) {
      hints.push(
        `- 多文件/较大改动：读取 ${SKILLS_BASE}/incremental-implementation/SKILL.md，先列 Slice Plan`
      );
    }
  }
}

function dedupeAndCap(hints: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const h of hints) {
    if (!seen.has(h)) {
      seen.add(h);
      unique.push(h);
    }
  }
  return unique.slice(0, HINT_CAP);
}
