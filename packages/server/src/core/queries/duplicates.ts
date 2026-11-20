import type { Tx } from "../../db/pool.js";

/**
 * The static SQL of the duplicate finder (core/duplicates.ts, ADR 0012). Its grouping and similarity
 * statements are built at run time from the query compiler's column expressions and stay, with their
 * execution, in core/duplicates.ts.
 */

/**
 * Lowers the statement timeout and sets the trigram similarity threshold for the rest of the
 * transaction (a savepoint the finder always rolls back). Both are passed as text, as set_config takes them.
 */
export async function limitFuzzyComparison(tx: Tx, timeoutMs: string, similarityThreshold: string): Promise<void> {
  await tx`SELECT set_config('statement_timeout', ${timeoutMs}, true), set_config('pg_trgm.similarity_threshold', ${similarityThreshold}, true)`;
}
