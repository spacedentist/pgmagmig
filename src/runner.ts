import { performance } from "node:perf_hooks";
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

  if (!pending) {
    console.log("pgmagmig: up to date");
    return { rolledBack: [], applied: [], pending, rollbackRequired };
  }

  // Print plan
  const mode = opts.dryRun ? "dry run" : opts.check ? "check" : null;
  printPlan(plan, mode);

  // Stop if dry-run or check
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

    const deleteSql =
      `DELETE FROM ${opts.managementTable} WHERE sequence = ${m.sequence}`;
    const userStmts = m.down === "" ? [] : splitSql(m.down);
    const allStmts = ["BEGIN", deleteSql, ...userStmts, "COMMIT"];

    console.error(`\n-- ${fmtSeq(m.sequence)} ${m.title}\n`);
    const migrationStart = performance.now();
    let stmtIndex = 0;

    try {
      for (stmtIndex = 0; stmtIndex < allStmts.length; stmtIndex++) {
        await execWithProgress(opts.db, allStmts[stmtIndex], stmtIndex + 1, allStmts.length);
      }
    } catch (err) {
      await opts.db.query("ROLLBACK").catch(() => {});
      console.error(
        "\n" + formatPgError(err, m.sequence, m.title, stmtIndex + 1, allStmts.length),
      );
      throw new MigrationError(
        `Migration ${fmtSeq(m.sequence)} failed`,
        err,
      );
    }

    console.error(
      `\n-- ${fmtSeq(m.sequence)} done (${fmtDuration(performance.now() - migrationStart)})`,
    );
    result.rolledBack.push(m);
  }

  // Apply
  for (const m of plan.toApply) {
    const userStmts = splitSql(m.up);
    const insertSql =
      `INSERT INTO ${opts.managementTable} (sequence, uuid, title, down) VALUES (${m.sequence}, '${m.uuid}', ${escapeSqlString(m.title)}, ${m.down === null ? "NULL" : escapeSqlString(m.down)})`;
    const allStmts = ["BEGIN", ...userStmts, insertSql, "COMMIT"];

    console.error(`\n-- ${fmtSeq(m.sequence)} ${m.title}\n`);
    const migrationStart = performance.now();
    let stmtIndex = 0;

    try {
      for (stmtIndex = 0; stmtIndex < allStmts.length; stmtIndex++) {
        await execWithProgress(opts.db, allStmts[stmtIndex], stmtIndex + 1, allStmts.length);
      }
    } catch (err) {
      await opts.db.query("ROLLBACK").catch(() => {});
      console.error(
        "\n" + formatPgError(err, m.sequence, m.title, stmtIndex + 1, allStmts.length),
      );
      throw new MigrationError(
        `Migration ${fmtSeq(m.sequence)} failed`,
        err,
      );
    }

    console.error(
      `\n-- ${fmtSeq(m.sequence)} done (${fmtDuration(performance.now() - migrationStart)})`,
    );
    result.applied.push(m);
  }

  // Final summary to stdout
  const parts: string[] = [];
  if (result.rolledBack.length > 0) {
    parts.push(`${result.rolledBack.length} rolled back`);
  }
  if (result.applied.length > 0) {
    parts.push(`${result.applied.length} applied`);
  }
  console.log(`pgmagmig: ${parts.join(", ")}`);

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

export class MigrationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "MigrationError";
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function fmtSeq(n: number): string {
  return String(n).padStart(4, "0");
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const INDENT = "        ";

function indentSql(sql: string): string {
  const lines = sql.split("\n").map((line) => line.trimEnd());
  if (lines.length === 1) return lines[0];
  return lines
    .map((line, i) => (i === 0 ? line : INDENT + line))
    .join("\n");
}

function printPlan(
  plan: MigrationPlan,
  mode: string | null,
): void {
  const header = mode
    ? `pgmagmig: migration plan (${mode})`
    : "pgmagmig: migration plan";
  console.error(header);
  console.error("");

  for (const m of plan.toRollback) {
    console.error(`  rollback ${fmtSeq(m.sequence)} ${m.title}`);
  }
  for (const m of plan.toApply) {
    console.error(`  apply    ${fmtSeq(m.sequence)} ${m.title}`);
  }

  console.error("");
  const parts: string[] = [];
  if (plan.toRollback.length > 0) {
    const n = plan.toRollback.length;
    parts.push(`${n} ${n === 1 ? "migration" : "migrations"} to roll back`);
  }
  if (plan.toApply.length > 0) {
    const n = plan.toApply.length;
    parts.push(`${n} ${n === 1 ? "migration" : "migrations"} to apply`);
  }
  console.error(parts.join(", "));
}

function formatPgError(
  err: unknown,
  sequence: number,
  title: string,
  stmtIndex: number,
  stmtTotal: number,
): string {
  const pgErr = err as {
    code?: string;
    message?: string;
    detail?: string;
    hint?: string;
    where?: string;
  };

  const lines: string[] = [];
  lines.push(
    `ERROR in ${fmtSeq(sequence)} "${title}", statement ${stmtIndex}/${stmtTotal}`,
  );
  if (pgErr.code) lines.push(`  Code:    ${pgErr.code}`);
  if (pgErr.message) lines.push(`  Message: ${pgErr.message}`);
  if (pgErr.detail) lines.push(`  Detail:  ${pgErr.detail}`);
  if (pgErr.hint) lines.push(`  Hint:    ${pgErr.hint}`);
  if (pgErr.where) lines.push(`  Where:   ${pgErr.where}`);

  return lines.join("\n");
}

async function execWithProgress(
  db: Queryable,
  sql: string,
  index: number,
  total: number,
): Promise<void> {
  console.error(`  [${index}/${total}] ${indentSql(sql)}`);
  const start = performance.now();
  try {
    await db.query(sql);
  } catch (err) {
    console.error(`${INDENT}FAILED`);
    throw err;
  }
  console.error(`${INDENT}ok (${fmtDuration(performance.now() - start)})`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeSqlString(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}
