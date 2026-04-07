import { getDb } from "../db/connection.js";
import { insert } from "../db/repository.js";
import { generateEmbedding } from "./index.js";

/**
 * Default similarity threshold (L2 distance).
 * Memories with distance above this are excluded from 7-90 day recall.
 * Tuned for local bge-small-zh-v1.5 (512-dim). Adjust via setSimilarityThreshold()
 * if switching to a different embedding model (e.g. OpenAI text-embedding-3-small).
 */
let similarityThreshold = 0.3;

/**
 * Override the similarity threshold at startup.
 */
export function setSimilarityThreshold(threshold: number): void {
  similarityThreshold = threshold;
}

export interface MemoryData {
  role: string;
  summary: string;
  content: string;
  trigger: string;
}

/**
 * Insert a memory entry and generate its embedding vector.
 * Writes to both `memory` and `memory_vec` tables.
 */
export async function insertMemory(data: MemoryData): Promise<number> {
  const { lastInsertRowid } = insert("memory", data);

  // Generate embedding from summary (concise, best for semantic search)
  try {
    const embedding = await generateEmbedding(data.summary);
    const db = getDb();
    // sqlite-vec vec0 checks sqlite3_value_type(id) == SQLITE_INTEGER at the C level.
    // JS number binds as SQLITE_FLOAT; only BigInt binds as SQLITE_INTEGER.
    // Embedding must be a Float32Array (bound as BLOB) per sqlite-vec docs.
    const idInt = typeof lastInsertRowid === "bigint" ? lastInsertRowid : BigInt(lastInsertRowid);
    db.prepare("INSERT INTO memory_vec(id, embedding) VALUES (?, ?)").run(
      idInt,
      new Float32Array(embedding)
    );
  } catch (err) {
    console.log(`   ⚠️  记忆 #${lastInsertRowid} embedding 生成失败: ${err}`);
  }

  return Number(lastInsertRowid);
}

export interface MemoryEntry {
  id: number;
  summary: string;
  content: string;
  role: string;
  created_at: string;
}

/**
 * Build a recall prompt from recent memories for a role, using vector similarity.
 *
 * - Last 7 days: always included
 * - 7-30 days: only if similar (distance < similarityThreshold)
 * - 30-90 days: only if highly similar (distance < similarityThreshold * 0.6)
 * - 90+ days: excluded (cleaned by cleanExpiredMemories)
 *
 * @param role - The role to recall memories for
 * @param currentContext - Current context text for semantic matching (optional)
 * @param limit - Max memories to include (default 10)
 */
export async function buildRecallPrompt(
  role: string,
  currentContext?: string,
  limit: number = 10
): Promise<string> {
  const db = getDb();

  // If no context for vector search, fall back to time-based recall
  if (!currentContext) {
    const memories = db
      .prepare(
        `SELECT id, summary FROM memory
         WHERE role = ? AND created_at > datetime('now', '-7 days')
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(role, limit) as Array<{ id: number; summary: string }>;

    return formatRecallPrompt(memories);
  }

  // Vector-based recall
  const queryEmbedding = await generateEmbedding(currentContext);

  // Get candidate memory IDs from vector search (fetch more than needed for filtering)
  const vecResults = db
    .prepare("SELECT id, distance FROM memory_vec WHERE embedding MATCH ? AND k = ?")
    .all(new Float32Array(queryEmbedding), limit * 3) as Array<{
    id: number;
    distance: number;
  }>;

  if (vecResults.length === 0) {
    return formatRecallPrompt([]);
  }

  const ids = vecResults.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(", ");
  const distMap = new Map(vecResults.map((r) => [r.id, r.distance]));

  // Fetch memories within 90 days (90+ are cleaned by cleanExpiredMemories)
  const memories = db
    .prepare(
      `SELECT id, summary, created_at FROM memory
       WHERE role = ? AND id IN (${placeholders})
         AND created_at > datetime('now', '-90 days')
       ORDER BY created_at DESC`
    )
    .all(role, ...ids) as Array<{
    id: number;
    summary: string;
    created_at: string;
  }>;

  // Apply time-decay filtering
  const now = Date.now();
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const filtered = memories.filter((m) => {
    const age = now - new Date(m.created_at).getTime();
    const distance = distMap.get(m.id) ?? 1;

    // Last 7 days: include all
    if (age <= SEVEN_DAYS) return true;
    // 7-30 days: only high similarity (low distance)
    if (age <= THIRTY_DAYS) return distance < similarityThreshold;
    // 30-90 days: only very high similarity (stricter threshold)
    return distance < similarityThreshold * 0.6;
  });

  // Sort by vector distance (most relevant first)
  filtered.sort((a, b) => (distMap.get(a.id) ?? 1) - (distMap.get(b.id) ?? 1));

  return formatRecallPrompt(filtered.slice(0, limit));
}

/**
 * Clean up expired memories (90+ days old).
 * Called during iteration review.
 *
 * Memory lifecycle:
 * - 0-7 days: always recalled
 * - 7-30 days: recalled only if semantically relevant (distance < similarityThreshold)
 * - 30-90 days: recalled only if highly relevant (distance < similarityThreshold * 0.6)
 * - 90+ days: deleted by this function
 */
export function cleanExpiredMemories(): number {
  const db = getDb();

  // Get IDs of expired memories (90+ days)
  const expired = db
    .prepare("SELECT id FROM memory WHERE created_at < datetime('now', '-90 days')")
    .all() as Array<{ id: number }>;

  if (expired.length === 0) return 0;

  const ids = expired.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(", ");

  // Delete from both tables
  db.prepare(`DELETE FROM memory_vec WHERE id IN (${placeholders})`).run(...ids);
  const result = db.prepare(`DELETE FROM memory WHERE id IN (${placeholders})`).run(...ids);

  return result.changes;
}

function formatRecallPrompt(memories: Array<{ id: number; summary: string }>): string {
  if (memories.length === 0) return "";

  const summaries = memories.map((m) => `- [#${m.id}] ${m.summary}`).join("\n");

  return `## 近期工作回忆
以下是你最近的工作记忆摘要，请在接下来的工作中参考这些上下文：
${summaries}

如需了解某条记忆的详细内容，可以通过 database_query 查询 memory 表。`;
}
