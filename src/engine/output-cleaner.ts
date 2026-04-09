import { getDb } from '../db/connection.js';

/**
 * Clean up expired role outputs (90+ days old).
 * Called during iteration review alongside memory cleanup.
 */
export function cleanExpiredOutputs(): number {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM role_outputs WHERE created_at < datetime('now', '-90 days')")
    .run();
  return result.changes;
}
