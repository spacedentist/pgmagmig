import { PGlite } from "@electric-sql/pglite";
import { extractSchema } from "./extract.js";
import { splitSql } from "./split-sql.js";
import { compareSchemas } from "./validate.js";
import type { MigrationFile, Queryable, ValidationError } from "./types.js";

/**
 * Verify that down-migrations correctly reverse their up-migrations.
 *
 * For each checked migration we run an up → down → up "dance" against a
 * throwaway PGlite and compare schema snapshots:
 *   - after `down`, the schema must match the state *before* the up ran;
 *   - after re-applying `up`, it must match the state after the first up.
 *
 * Migrations whose `down` is null (omitted) or "" (an intentional no-op) are
 * skipped — there is nothing to reverse. Only a trailing window of migrations
 * is danced (default: the last one); earlier ones are applied plainly to build
 * the base state.
 */

export type DownCheckStatus =
  | "ok" // down reverses correctly and re-applying up is consistent
  | "no-down" // down omitted (null) — nothing to verify
  | "noop-down" // down is an intentional no-op ("") — nothing to verify
  | "down-mismatch" // after down, schema differs from the pre-up state
  | "up-mismatch" // after re-applying up, schema differs from the first up
  | "up-error" // applying up threw
  | "down-error"; // applying down threw

export interface DownCheck {
  sequence: number;
  title: string;
  filename: string;
  invalid: boolean;
  status: DownCheckStatus;
  /** For the *-mismatch statuses: how the schemas differed. */
  errors?: ValidationError[];
  /** For the *-error statuses: the database error message. */
  message?: string;
}

export interface VerifyDownResult {
  checks: DownCheck[];
  ok: boolean;
}

export async function verifyDownMigrations(
  migrations: MigrationFile[],
  opts: { count?: number } = {},
): Promise<VerifyDownResult> {
  const total = migrations.length;
  const requested = opts.count ?? 1;
  const danceCount = Math.min(Math.max(requested, 0), total);
  const danceFrom = total - danceCount;

  const db = new PGlite();
  const checks: DownCheck[] = [];
  try {
    // Build the base state: apply the ups of migrations before the dance
    // window without checking their downs.
    for (let i = 0; i < danceFrom; i++) {
      await applyMigration(db, migrations[i].up);
    }

    // `before` tracks the schema state prior to each danced migration's up.
    let before = await extractSchema(db);

    for (let i = danceFrom; i < total; i++) {
      const m = migrations[i];
      const base = {
        sequence: m.sequence,
        title: m.title,
        filename: m.filename,
        invalid: !!m.invalid,
      };

      // up
      try {
        await applyMigration(db, m.up);
      } catch (e) {
        checks.push({ ...base, status: "up-error", message: errMessage(e) });
        break; // the chain is broken; later migrations can't be trusted
      }
      const afterUp = await extractSchema(db);

      if (m.down === null) {
        checks.push({ ...base, status: "no-down" });
        before = afterUp;
        continue;
      }
      if (m.down === "") {
        checks.push({ ...base, status: "noop-down" });
        before = afterUp;
        continue;
      }

      // down → must restore the pre-up state
      try {
        await applyMigration(db, m.down);
      } catch (e) {
        checks.push({ ...base, status: "down-error", message: errMessage(e) });
        break;
      }
      const afterDown = await extractSchema(db);
      const downErrors = compareSchemas(afterDown, before);

      // The down not restoring the schema is the primary finding. Report it and
      // stop: a re-applied up on a half-restored schema would fail for a
      // symptomatic reason (e.g. "column already exists"), masking the cause,
      // and the chain is no longer in a known-good state to continue from.
      if (downErrors.length > 0) {
        checks.push({ ...base, status: "down-mismatch", errors: downErrors });
        break;
      }

      // up again → must reproduce the first up's state
      try {
        await applyMigration(db, m.up);
      } catch (e) {
        checks.push({ ...base, status: "up-error", message: errMessage(e) });
        break;
      }
      const upErrors = compareSchemas(await extractSchema(db), afterUp);
      if (upErrors.length > 0) {
        checks.push({ ...base, status: "up-mismatch", errors: upErrors });
        break;
      }

      checks.push({ ...base, status: "ok" });
      before = afterUp;
    }
  } finally {
    await db.close();
  }

  const ok = checks.every(
    (c) => c.status === "ok" || c.status === "no-down" || c.status === "noop-down",
  );
  return { checks, ok };
}

/** Apply one migration's SQL as a single transaction, mirroring the runner. */
async function applyMigration(db: Queryable, sql: string): Promise<void> {
  await db.query("BEGIN");
  try {
    for (const stmt of splitSql(sql)) {
      if (stmt.trim()) await db.query(stmt);
    }
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
