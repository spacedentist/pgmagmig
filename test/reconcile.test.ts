import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffSchema } from "../src/diff.js";
import { extractSchema } from "../src/extract.js";
import { reconcileAgainst, reconcileMigration } from "../src/reconcile.js";
import { splitSql } from "../src/split-sql.js";
import { compareSchemas } from "../src/validate.js";
import type { DatabaseSchema, Statement } from "../src/types.js";

// One PGlite for the whole file. `reconcileMigration` reuses a single instance
// across all of its rounds already; here we also reuse one instance across all
// the test scaffolding (schema extraction, verification, the static contrast),
// isolating each step with BEGIN/ROLLBACK.
let db: PGlite;
beforeAll(() => {
  db = new PGlite();
});
afterAll(async () => {
  await db.close();
});

async function inTxn<T>(fn: () => Promise<T>): Promise<T> {
  await db.query("BEGIN");
  try {
    await db.query("SET check_function_bodies = false");
    return await fn();
  } finally {
    await db.query("ROLLBACK");
  }
}

async function apply(sql: string): Promise<void> {
  for (const s of splitSql(sql)) if (s.trim()) await db.query(s);
}

async function schemaOf(sql: string): Promise<DatabaseSchema> {
  return inTxn(async () => {
    await apply(sql);
    return extractSchema(db);
  });
}

/**
 * Plan a migration with the loop (running its rounds on the shared db), then
 * independently replay the recorded statements in a single pass on a fresh
 * `from` state and confirm the result equals the target.
 */
async function reconcile(
  fromSql: string,
  toSql: string,
): Promise<{ statements: Statement[]; errorCount: number }> {
  const to = await schemaOf(toSql);

  const statements = await inTxn(async () => {
    await apply(fromSql);
    return reconcileAgainst(db, to);
  });

  const errorCount = await inTxn(async () => {
    await apply(fromSql);
    for (const s of statements) await db.query(s.ddl);
    return compareSchemas(await extractSchema(db), to).length;
  });

  return { statements, errorCount };
}

async function staticDiffApplies(fromSql: string, toSql: string): Promise<boolean> {
  const from = await schemaOf(fromSql);
  const to = await schemaOf(toSql);
  const ddl = diffSchema(from, to);
  return inTxn(async () => {
    try {
      await apply(fromSql);
      await apply(ddl);
      return true;
    } catch {
      return false;
    }
  });
}

describe("reconcileMigration", () => {
  it("produces no statements when from equals to", async () => {
    const { statements } = await reconcile(
      "CREATE TABLE t (id integer)",
      "CREATE TABLE t (id integer)",
    );
    expect(statements).toEqual([]);
  });

  it("creates a table from empty", async () => {
    const { errorCount } = await reconcile(
      "",
      "CREATE TABLE users (id integer NOT NULL, name text)",
    );
    expect(errorCount).toBe(0);
  });

  it("orders interdependent function creation", async () => {
    const { errorCount } = await reconcile(
      "",
      `CREATE FUNCTION foo(i integer) RETURNS integer AS $$ SELECT i+1 $$ LANGUAGE sql;
       CREATE FUNCTION bar(i integer) RETURNS integer AS $$ SELECT foo(i)+1 $$ LANGUAGE sql;`,
    );
    expect(errorCount).toBe(0);
  });

  // Case A — removing a stack of interdependent views. Adversarial names: the
  // depended-on view (aaa_base) sorts before its dependent (zzz_top), so the
  // static differ drops it first and fails; the loop's CASCADE + re-diff copes.
  it("removes a stack of interdependent views (Case A)", async () => {
    const fromSql = `CREATE TABLE t (x integer);
      CREATE VIEW aaa_base AS SELECT x FROM t;
      CREATE VIEW zzz_top AS SELECT x FROM aaa_base;`;
    const toSql = `CREATE TABLE t (x integer);`;

    expect(await staticDiffApplies(fromSql, toSql)).toBe(false);
    const { errorCount } = await reconcile(fromSql, toSql);
    expect(errorCount).toBe(0);
  });

  // Case B — changing a base view whose dependent is unchanged. The dependent
  // must be dropped and recreated even though it did not change.
  it("changes a base view with an unchanged dependent (Case B)", async () => {
    const fromSql = `CREATE TABLE t (x integer, y integer);
      CREATE VIEW base AS SELECT x, y FROM t;
      CREATE VIEW top AS SELECT x FROM base;`;
    const toSql = `CREATE TABLE t (x integer, y integer);
      CREATE VIEW base AS SELECT y, x FROM t;
      CREATE VIEW top AS SELECT x FROM base;`;

    expect(await staticDiffApplies(fromSql, toSql)).toBe(false);
    const { statements, errorCount } = await reconcile(fromSql, toSql);
    expect(errorCount).toBe(0);
    expect(statements.some((s) => /DROP VIEW .*base.* CASCADE/.test(s.ddl))).toBe(true);
    expect(statements.filter((s) => /CREATE VIEW/.test(s.ddl)).length).toBe(2);
  });

  it("records the check_function_bodies prelude at most once", async () => {
    const { statements } = await reconcile(
      "",
      `CREATE FUNCTION a(i integer) RETURNS integer AS $$ SELECT i+1 $$ LANGUAGE sql;
       CREATE FUNCTION b(i integer) RETURNS integer AS $$ SELECT a(i)+1 $$ LANGUAGE sql;
       CREATE FUNCTION c(i integer) RETURNS integer AS $$ SELECT b(i)+1 $$ LANGUAGE sql;`,
    );
    const sets = statements.filter((s) =>
      /SET\s+check_function_bodies\s*=\s*false/i.test(s.ddl),
    );
    expect(sets.length).toBe(1);
  });

  it("replaces a function that a view depends on", async () => {
    const { errorCount } = await reconcile(
      `CREATE FUNCTION f() RETURNS integer AS $$ SELECT 1 $$ LANGUAGE sql;
       CREATE VIEW v AS SELECT f() AS n;`,
      `CREATE FUNCTION f() RETURNS integer AS $$ SELECT 2 $$ LANGUAGE sql;
       CREATE VIEW v AS SELECT f() AS n;`,
    );
    expect(errorCount).toBe(0);
  });

  // Exercises the public entry point end to end (it manages its own instance
  // and bootstraps `from` via the loop).
  it("reconcileMigration() plans a working migration end to end", async () => {
    const from = await schemaOf("CREATE TABLE t (x integer)");
    const to = await schemaOf(`CREATE TABLE t (x integer);
      CREATE VIEW v AS SELECT x FROM t;`);
    const statements = await reconcileMigration(from, to);
    expect(statements.some((s) => /CREATE VIEW/.test(s.ddl))).toBe(true);
  });
});
