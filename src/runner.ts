import type { Logger } from "pino";
import { splitSql } from "./split-sql.js";
import type { MigrationFile, Queryable } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppliedMigration {
  sequence: number;
  uuid: string;
  title: string;
  down: string | null;
}

export interface MigrationPlan {
  toRollback: AppliedMigration[];
  toApply: MigrationFile[];
}

export interface MigrationResult {
  rolledBack: AppliedMigration[];
  applied: MigrationFile[];
}

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

const TABLE_NAME_RE =
  /^(?:[a-zA-Z_][a-zA-Z0-9_$]*|"(?:[^"]|"")*")(?:\.(?:[a-zA-Z_][a-zA-Z0-9_$]*|"(?:[^"]|"")*"))?$/;

export function validateManagementTableName(name: string): void {
  if (!TABLE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid management table name: ${name}. Must be a valid SQL identifier, optionally schema-qualified.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Read applied migrations
// ---------------------------------------------------------------------------

export async function readAppliedMigrations(
  db: Queryable,
  tableName: string,
  allowMissing: boolean,
): Promise<AppliedMigration[]> {
  validateManagementTableName(tableName);

  let rows: AppliedMigration[];
  try {
    const result = await db.query<AppliedMigration>(
      `SELECT sequence, uuid, title, down FROM ${tableName} ORDER BY sequence`,
    );
    rows = result.rows;
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr.code === "42P01" && allowMissing) {
      return [];
    }
    throw err;
  }

  // Validate consecutive from 1
  for (let i = 0; i < rows.length; i++) {
    const expected = i + 1;
    if (rows[i].sequence !== expected) {
      throw new Error(
        `Management table corruption: expected sequence ${expected}, got ${rows[i].sequence}`,
      );
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export function planMigration(
  files: MigrationFile[],
  applied: AppliedMigration[],
): MigrationPlan {
  // Find longest matching prefix where UUIDs agree at same index
  let matchLength = 0;
  const minLen = Math.min(files.length, applied.length);
  for (let i = 0; i < minLen; i++) {
    if (files[i].uuid === applied[i].uuid) {
      matchLength = i + 1;
    } else {
      break;
    }
  }

  // Everything beyond the match point
  const toRollback = applied.slice(matchLength).reverse();
  const toApply = files.slice(matchLength);

  return { toRollback, toApply };
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export async function migrate(opts: {
  db: Queryable;
  files: MigrationFile[];
  managementTable: string;
  allowMissingManagementTable?: boolean;
  allowRollback?: boolean;
  dryRun?: boolean;
  check?: boolean;
  logger?: Logger;
}): Promise<MigrationResult & { pending: boolean; rollbackRequired: boolean }> {
  validateManagementTableName(opts.managementTable);

  const applied = await readAppliedMigrations(
    opts.db,
    opts.managementTable,
    opts.allowMissingManagementTable ?? false,
  );

  const plan = planMigration(opts.files, applied);
  const pending =
    plan.toRollback.length > 0 || plan.toApply.length > 0;
  const rollbackRequired = plan.toRollback.length > 0;

  // Always print the plan
  if (plan.toRollback.length > 0) {
    opts.logger?.info(
      { count: plan.toRollback.length },
      "Rollback required",
    );
    for (const m of plan.toRollback) {
      opts.logger?.info(
        { sequence: m.sequence, title: m.title },
        "  rollback",
      );
    }
  }
  if (plan.toApply.length > 0) {
    opts.logger?.info(
      { count: plan.toApply.length },
      "Migrations to apply",
    );
    for (const m of plan.toApply) {
      opts.logger?.info(
        { sequence: m.sequence, title: m.title },
        "  apply",
      );
    }
  }

  // Stop if dry-run, check, or rollback not allowed
  if (opts.dryRun || opts.check) {
    return { rolledBack: [], applied: [], pending, rollbackRequired };
  }

  if (rollbackRequired && !opts.allowRollback) {
    throw new RollbackRequiredError(plan.toRollback.length);
  }

  const result: MigrationResult = { rolledBack: [], applied: [] };

  // Rollback
  for (const m of plan.toRollback) {
    if (m.down === null) {
      throw new Error(
        `Cannot roll back migration ${m.sequence} (${m.title}): no down migration available`,
      );
    }
    opts.logger?.info(
      { sequence: m.sequence, title: m.title },
      "Rolling back",
    );
    await withTransaction(opts.db, opts.logger, async (db) => {
      // DELETE first, then execute down SQL
      await execAndLog(
        db,
        opts.logger,
        `DELETE FROM ${opts.managementTable} WHERE sequence = ${m.sequence}`,
      );
      if (m.down !== "") {
        for (const stmt of splitSql(m.down!)) {
          await execAndLog(db, opts.logger, stmt);
        }
      }
    });
    result.rolledBack.push(m);
  }

  // Apply
  for (const m of plan.toApply) {
    opts.logger?.info(
      { sequence: m.sequence, title: m.title },
      "Applying",
    );
    await withTransaction(opts.db, opts.logger, async (db) => {
      // Execute up SQL, then INSERT
      for (const stmt of splitSql(m.up)) {
        await execAndLog(db, opts.logger, stmt);
      }
      await execAndLog(
        db,
        opts.logger,
        `INSERT INTO ${opts.managementTable} (sequence, uuid, title, down) VALUES (${m.sequence}, '${m.uuid}', ${escapeSqlString(m.title)}, ${m.down === null ? "NULL" : escapeSqlString(m.down)})`,
      );
    });
    result.applied.push(m);
  }

  return { ...result, pending, rollbackRequired };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RollbackRequiredError extends Error {
  constructor(count: number) {
    super(
      `${count} migration(s) need to be rolled back. ` +
      `Down-migrations are often destructive. ` +
      `Use --allow-rollback to proceed.`,
    );
    this.name = "RollbackRequiredError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTransaction(
  db: Queryable,
  logger: Logger | undefined,
  fn: (db: Queryable) => Promise<void>,
): Promise<void> {
  await execAndLog(db, logger, "BEGIN");
  try {
    await fn(db);
    await execAndLog(db, logger, "COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

async function execAndLog(
  db: Queryable,
  logger: Logger | undefined,
  sql: string,
): Promise<void> {
  const truncated = sql.length > 200 ? sql.substring(0, 200) + "…" : sql;
  logger?.debug({ sql: truncated }, "exec");
  await db.query(sql);
}

function escapeSqlString(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}
