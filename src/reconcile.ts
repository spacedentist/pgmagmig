import { PGlite } from "@electric-sql/pglite";
import { diffSchemaStatements } from "./diff.js";
import { extractSchema } from "./extract.js";
import type { DatabaseSchema, Queryable, Statement } from "./types.js";

/**
 * Execution-guided migration planner (design doc §6.8).
 *
 * Instead of computing the whole plan up front, we bootstrap a throwaway PGlite
 * with the `from` schema and repeatedly ask "what's still different from `to`?",
 * applying each round of DDL to the shadow database and re-extracting. The
 * sequence of statements we execute *is* the migration.
 *
 * Why a loop: dropping a dataless object (a view, function, trigger, or index)
 * with `CASCADE` clears its dependents; the next round's diff simply notices
 * they are missing and recreates them. This dissolves drop-ordering and
 * cascade-recreation of interdependent views without any static dependency
 * bookkeeping.
 *
 * The oracle compares *schema*, not data, so it is blind to data loss — which
 * is exactly why only dataless drops cascade here; data-bearing changes come
 * from the same atoms the one-shot differ uses, with their hazards intact.
 */
export async function reconcileMigration(
  from: DatabaseSchema,
  to: DatabaseSchema,
): Promise<Statement[]> {
  const db = new PGlite();
  try {
    // Disable body validation so bootstrapping (and later function creation)
    // never trips over function ordering on the shadow database.
    await db.query("SET check_function_bodies = false");
    // Build the `from` state with the loop itself (empty → from), so its own
    // dependency ordering is handled the same way; then record the real
    // migration (from → to).
    await reconcileAgainst(db, from);
    return await reconcileAgainst(db, to);
  } finally {
    await db.close();
  }
}

/**
 * Reconcile a live database (already holding the `from` state) towards `to`,
 * returning the statements executed. Exposed separately so callers that already
 * have a bootstrapped instance — e.g. tests, or a future `migrate` path — can
 * reuse it.
 */
export async function reconcileAgainst(
  db: Queryable,
  to: DatabaseSchema,
): Promise<Statement[]> {
  const executed: Statement[] = [];

  // Convergence is bounded by dependency depth; this is a generous backstop
  // that turns a planning bug into a loud error instead of a hang.
  const maxRounds = objectCount(to) + objectCount(await extractSchema(db)) + 10;

  let emittedBodyCheck = false;
  for (let round = 0; round < maxRounds; round++) {
    const current = await extractSchema(db);
    const plan = diffSchemaStatements(current, to, { cascadeDatalessDrops: true });
    if (plan.length === 0) {
      return executed; // converged
    }
    for (const stmt of plan) {
      await db.query(stmt.ddl);
      // Each round that creates a function re-emits `SET check_function_bodies
      // = false`. It is idempotent and, within the single migration
      // transaction, one occurrence covers the rest — so record only the first.
      if (isBodyCheckOff(stmt.ddl)) {
        if (emittedBodyCheck) continue;
        emittedBodyCheck = true;
      }
      executed.push(stmt);
    }
  }

  throw new Error(
    "reconcileMigration did not converge — likely a planning bug (a step that " +
      "does not reduce the remaining difference)",
  );
}

function isBodyCheckOff(ddl: string): boolean {
  return /^\s*SET\s+check_function_bodies\s*=\s*false\s*$/i.test(ddl);
}

function objectCount(schema: DatabaseSchema): number {
  let n =
    Object.keys(schema.schemas).length +
    Object.keys(schema.extensions).length +
    Object.keys(schema.enums).length +
    Object.keys(schema.sequences).length +
    Object.keys(schema.tables).length +
    Object.keys(schema.views).length +
    Object.keys(schema.triggers).length +
    Object.keys(schema.indexes).length;
  for (const overloads of Object.values(schema.functions)) n += overloads.length;
  return n;
}
