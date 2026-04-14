import { select, update, insert, rawQuery } from '../db/repository.js';
import { MessageStatus } from '../db/types.js';
import type { SessionManager } from './session-manager.js';
import { cleanExpiredMemories } from '../embedding/memory.js';
import { cleanExpiredOutputs } from './output-cleaner.js';
import { engineBus, EngineEvents, type DispatchCompletePayload } from './event-bus.js';
import { Role } from './role-manager.js';

/** SessionManager injected by the engine at startup (via initIterationChecker). */
let storedSessionManager: SessionManager | null = null;

/**
 * Inject the SessionManager so event-driven callbacks can access it.
 * Call once in cli/engine.ts before starting the scheduler loop.
 * Also registers the DISPATCH_COMPLETE listener on first call.
 */
export function initIterationChecker(sm: SessionManager | null): void {
  storedSessionManager = sm;
}

// Subscribe to dispatch events — check iteration review only after PM dispatches.
engineBus.on(EngineEvents.DISPATCH_COMPLETE, (payload: DispatchCompletePayload) => {
  if (payload.role === Role.PM) {
    checkIterationReview(storedSessionManager);
  }
});

interface IterationRow {
  id: number;
  name: string | null;
  status: string;
}

/**
 * Check completed iterations for review status.
 * When PM marks an iteration as 'reviewed':
 * 1. Release task sessions for DEV
 * 2. Send reflection triggers to participating roles
 * 3. Clean up expired memories and outputs
 */
export function checkIterationReview(sessionManager?: SessionManager | null): void {
  // Find iterations that just got reviewed (PM updated status to 'reviewed')
  const reviewedIterations = select<IterationRow>('iterations', { status: 'reviewed' });

  for (const iter of reviewedIterations) {
    // Check if we already processed this review (reflection already sent)
    const existingReflection = rawQuery(
      `SELECT id FROM messages
       WHERE related_iteration_id = ? AND type = 'reflection' LIMIT 1`,
      [iter.id]
    );
    if (existingReflection.length > 0) continue;

    // Release task sessions for completed tasks
    if (sessionManager) {
      const tasks = select<{ id: number }>('tasks', { iteration_id: iter.id });
      for (const task of tasks) {
        sessionManager.releaseTaskSession(task.id);
      }
    }

    // Send reflection trigger to all participating roles
    sendReflectionTriggers(iter);

    // Clean up expired memories and outputs
    const cleaned = cleanExpiredMemories();
    if (cleaned > 0) {
      insert('logs', {
        role: Role.SYS,
        action: 'memory_cleanup',
        content: `已清理 ${cleaned} 条过期记忆（90+ 天）`,
      });
      console.log(`   🧹 已清理 ${cleaned} 条过期记忆`);
    }
    const cleanedOutputs = cleanExpiredOutputs();
    if (cleanedOutputs > 0) {
      insert('logs', {
        role: Role.SYS,
        action: 'output_cleanup',
        content: `已清理 ${cleanedOutputs} 条过期角色输出（90+ 天）`,
      });
      console.log(`   🧹 已清理 ${cleanedOutputs} 条过期角色输出`);
    }

    // Update reviewed_at timestamp
    update('iterations', { id: iter.id }, { reviewed_at: new Date().toISOString() });

    insert('logs', {
      role: Role.SYS,
      action: 'iteration_reviewed',
      content: `迭代 #${iter.id} 回顾完成`,
    });

    console.log(`   ✅ 迭代 #${iter.id} 回顾完成`);
  }
}

/**
 * Send self-reflection trigger messages to all roles that participated in an iteration.
 * Participating roles are determined by who sent/received messages or was assigned tasks.
 */
function sendReflectionTriggers(iter: IterationRow): void {
  // Find all roles that participated via messages
  const messages = select<{ from_role: Role; to_role: Role }>('messages', {
    related_iteration_id: iter.id,
  });

  // Also check tasks assigned to roles
  const tasks = select<{ assigned_to: Role | null }>('tasks', { iteration_id: iter.id });

  const participatingRoles = new Set<Role>();
  for (const msg of messages) {
    if (msg.from_role !== Role.SYS) participatingRoles.add(msg.from_role);
    if (msg.to_role !== Role.SYS) participatingRoles.add(msg.to_role);
  }
  for (const task of tasks) {
    if (task.assigned_to) participatingRoles.add(task.assigned_to);
  }

  // Always include PM, exclude "user"
  participatingRoles.add(Role.PM);
  participatingRoles.delete(Role.USER);

  for (const role of participatingRoles) {
    insert('messages', {
      from_role: Role.SYS,
      to_role: role,
      type: 'reflection',
      content: buildReflectionPrompt(role, iter),
      status: MessageStatus.Unread,
      related_iteration_id: iter.id,
    });
  }

  insert('logs', {
    role: Role.SYS,
    action: 'reflection_triggered',
    content: `迭代 #${iter.id} 回顾完成，已向 ${[...participatingRoles].join(',')} 发送反思触发`,
  });
}

/**
 * Build a reflection prompt tailored to each role.
 */
function buildReflectionPrompt(role: Role, iter: IterationRow): string {
  const iterName = iter.name ? `「${iter.name}」` : '';
  const base = `【自我反思】迭代 #${iter.id}${iterName} 已完成回顾，请进行自我反思。`;

  const roleGuidance: Record<string, string> = {
    PM: '请回顾：需求理解是否准确？feature 定义质量如何？验收标准是否清晰？沟通效率如何？',
    DEV: '请回顾：代码质量如何？验收测试是否充分？是否有遗漏的测试场景？有无被打回？被打回的根因是什么？',
  };

  const guidance = roleGuidance[role] ?? '请回顾本次工作中的经验教训。';

  return [
    base,
    '',
    guidance,
    '',
    '反思产出：',
    '1. 将经验教训写入 memory 表（必须）',
    '2. 如发现需要用户决策的系统性问题，写入 proposals 表（可选，有则写，无则不写）',
  ].join('\n');
}
