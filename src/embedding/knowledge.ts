import { getDb } from "../db/connection.js";
import { insert } from "../db/repository.js";
import { generateEmbedding } from "./index.js";

export interface KnowledgeData {
  title: string;
  content: string;
  category: string;
  tags?: string;
  created_by: string;
}

/**
 * Insert a knowledge entry and generate its embedding vector.
 * Writes to both `knowledge` and `knowledge_vec` tables.
 */
export async function insertKnowledge(data: KnowledgeData): Promise<number> {
  const { lastInsertRowid } = insert("knowledge", data);

  // Generate embedding from title + content
  try {
    const embedding = await generateEmbedding(`${data.title} ${data.content}`);
    const db = getDb();
    // sqlite-vec vec0 checks sqlite3_value_type(id) == SQLITE_INTEGER at the C level.
    // JS number binds as SQLITE_FLOAT; only BigInt binds as SQLITE_INTEGER.
    // Embedding must be a Float32Array (bound as BLOB) per sqlite-vec docs.
    const idInt = typeof lastInsertRowid === "bigint" ? lastInsertRowid : BigInt(lastInsertRowid);
    db.prepare("INSERT INTO knowledge_vec(id, embedding) VALUES (?, ?)").run(
      idInt,
      new Float32Array(embedding)
    );
  } catch (err) {
    // Embedding failure is non-fatal — knowledge is still searchable by category/text
    console.log(`   ⚠️  知识条目 #${lastInsertRowid} embedding 生成失败: ${err}`);
  }

  return Number(lastInsertRowid);
}

export interface KnowledgeEntry {
  id: number;
  title: string;
  content: string;
  category: string;
  tags: string | null;
}

/**
 * Query relevant knowledge entries using vector similarity search.
 *
 * @param queryText - Text to search for (will be embedded)
 * @param category - Optional category filter (exact match)
 * @param limit - Max results (default 5)
 */
export async function queryRelevantKnowledge(
  queryText: string,
  category?: string,
  limit: number = 5
): Promise<KnowledgeEntry[]> {
  const db = getDb();
  const queryEmbedding = await generateEmbedding(queryText);

  // Use sqlite-vec KNN query to find nearest neighbors
  const vecResults = db
    .prepare("SELECT id, distance FROM knowledge_vec WHERE embedding MATCH ? AND k = ?")
    .all(new Float32Array(queryEmbedding), limit * 2) as Array<{
    id: number;
    distance: number;
  }>;

  if (vecResults.length === 0) return [];

  // Fetch full knowledge entries, optionally filtering by category
  const ids = vecResults.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(", ");

  let sql = `SELECT id, title, content, category, tags FROM knowledge
    WHERE id IN (${placeholders}) AND status = 'active'`;
  const params: (string | number)[] = [...ids];

  if (category) {
    sql += " AND category = ?";
    params.push(category);
  }

  const rows = db.prepare(sql).all(...params) as KnowledgeEntry[];

  // Sort by vector distance (preserve the vec search order)
  const distMap = new Map(vecResults.map((r) => [r.id, r.distance]));
  rows.sort((a, b) => (distMap.get(a.id) ?? 1) - (distMap.get(b.id) ?? 1));

  return rows.slice(0, limit);
}

/**
 * Query knowledge by category only (no vector search, for when embedding is unavailable).
 */
export function queryKnowledgeByCategory(category: string, limit: number = 10): KnowledgeEntry[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, title, content, category, tags FROM knowledge
       WHERE status = 'active' AND category = ?
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .all(category, limit) as KnowledgeEntry[];
}
