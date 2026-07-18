import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffSchema, diffSchemaAnnotated, diffSchemaStatements } from "../src/diff.js";
import type { DatabaseSchema } from "../src/types.js";
import { schemaFromSql, applyDiffAndExtract } from "./helpers.js";

let db: PGlite;
beforeAll(async () => { db = new PGlite(); });
afterAll(async () => { await db.close(); });

async function applyDiff(
  fromSql: string,
  toSql: string,
): Promise<{ from: DatabaseSchema; to: DatabaseSchema; applied: DatabaseSchema; ddl: string }> {
  const from = await schemaFromSql(db, fromSql);
  const to = await schemaFromSql(db, toSql);
  const ddl = diffSchema(from, to);
  const applied = await applyDiffAndExtract(db, fromSql, ddl);
  return { from, to, applied, ddl };
}

function expectTablesMatch(a: DatabaseSchema, b: DatabaseSchema) {
  expect(Object.keys(a.tables).sort()).toEqual(Object.keys(b.tables).sort());
  for (const key of Object.keys(a.tables)) {
    const at = a.tables[key];
    const bt = b.tables[key];
    expect(at.columns.length).toBe(bt.columns.length);
    for (let i = 0; i < at.columns.length; i++) {
      expect(at.columns[i].name).toBe(bt.columns[i].name);
      expect(at.columns[i].dataType).toBe(bt.columns[i].dataType);
      expect(at.columns[i].isNullable).toBe(bt.columns[i].isNullable);
      expect(at.columns[i].defaultValue).toBe(bt.columns[i].defaultValue);
      expect(at.columns[i].isGenerated).toBe(bt.columns[i].isGenerated);
    }
    expect(at.constraints.length).toBe(bt.constraints.length);
  }
}

describe("diffSchema", () => {
  it("produces empty diff for identical schemas", async () => {
    const sql = "CREATE TABLE t (id integer PRIMARY KEY, name text)";
    const from = await schemaFromSql(db, sql);
    const to = await schemaFromSql(db, sql);
    expect(diffSchemaStatements(from, to)).toEqual([]);
  });

  it("adds a new table", async () => {
    const { to, applied } = await applyDiff(
      "",
      "CREATE TABLE users (id integer NOT NULL, name text)",
    );
    expectTablesMatch(applied, to);
  });

  it("drops a table with hazard", async () => {
    const from = await schemaFromSql(db, "CREATE TABLE users (id integer)");
    const to = await schemaFromSql(db, "");
    const stmts = diffSchemaStatements(from, to);
    const drop = stmts.find((s) => s.ddl.includes("DROP TABLE"));
    expect(drop).toBeDefined();
    expect(drop!.hazards.some((h) => h.type === "DeletesData")).toBe(true);
  });

  it("adds a column", async () => {
    const { to, applied } = await applyDiff(
      "CREATE TABLE t (id integer NOT NULL)",
      "CREATE TABLE t (id integer NOT NULL, name text)",
    );
    expectTablesMatch(applied, to);
  });

  it("drops a column that has an index and a constraint on it", async () => {
    // No anticipatory ordering: the bucket order drops the constraint and index
    // before the column, and PG cleans up the rest.
    const { to, applied } = await applyDiff(
      `CREATE TABLE t (id integer, email text, UNIQUE (email));
       CREATE INDEX idx_email ON t (email)`,
      `CREATE TABLE t (id integer)`,
    );
    expectTablesMatch(applied, to);
    expect(applied.tables["public.t"].columns.find((c) => c.name === "email")).toBeUndefined();
    expect(Object.keys(applied.indexes)).not.toContain("public.idx_email");
  });

  it("drops a column with hazard", async () => {
    const from = await schemaFromSql(db, "CREATE TABLE t (id integer, name text)");
    const to = await schemaFromSql(db, "CREATE TABLE t (id integer)");
    const stmts = diffSchemaStatements(from, to);
    const drop = stmts.find((s) => s.ddl.includes("DROP COLUMN"));
    expect(drop).toBeDefined();
    expect(drop!.hazards.some((h) => h.type === "DeletesData")).toBe(true);
  });

  it("changes a column type with hazard", async () => {
    const { to, applied } = await applyDiff(
      "CREATE TABLE t (id integer, val integer)",
      "CREATE TABLE t (id integer, val bigint)",
    );
    expect(applied.tables["public.t"].columns[1].dataType).toBe("bigint");
  });

  it("changes nullability", async () => {
    const { to, applied } = await applyDiff(
      "CREATE TABLE t (id integer, name text)",
      "CREATE TABLE t (id integer, name text NOT NULL)",
    );
    expect(applied.tables["public.t"].columns[1].isNullable).toBe(false);
  });

  it("changes a column default", async () => {
    const { to, applied } = await applyDiff(
      "CREATE TABLE t (id integer, val integer DEFAULT 0)",
      "CREATE TABLE t (id integer, val integer DEFAULT 42)",
    );
    expect(applied.tables["public.t"].columns[1].defaultValue).toBe("42");
  });

  it("adds a constraint", async () => {
    const { to, applied } = await applyDiff(
      "CREATE TABLE t (id integer, name text)",
      "CREATE TABLE t (id integer PRIMARY KEY, name text UNIQUE)",
    );
    expect(applied.tables["public.t"].constraints.length).toBe(
      to.tables["public.t"].constraints.length,
    );
  });

  it("drops and recreates a changed constraint", async () => {
    const { to, applied } = await applyDiff(
      "CREATE TABLE t (id integer, a integer, CONSTRAINT uq UNIQUE (a))",
      "CREATE TABLE t (id integer, a integer, b integer, CONSTRAINT uq UNIQUE (a, b))",
    );
    const uq = applied.tables["public.t"].constraints.find((c) => c.name === "uq");
    expect(uq).toBeDefined();
    expect(uq!.columns).toContain("b");
  });

  it("adds and drops indexes", async () => {
    const { to, applied } = await applyDiff(
      `CREATE TABLE t (a integer, b integer);
       CREATE INDEX idx_a ON t (a)`,
      `CREATE TABLE t (a integer, b integer);
       CREATE INDEX idx_b ON t (b)`,
    );
    expect(Object.keys(applied.indexes)).toContain("public.idx_b");
    expect(Object.keys(applied.indexes)).not.toContain("public.idx_a");
  });

  it("adds a foreign key", async () => {
    const { to, applied } = await applyDiff(
      `CREATE TABLE parent (id integer PRIMARY KEY);
       CREATE TABLE child (id integer, parent_id integer)`,
      `CREATE TABLE parent (id integer PRIMARY KEY);
       CREATE TABLE child (id integer, parent_id integer,
         CONSTRAINT fk_parent FOREIGN KEY (parent_id) REFERENCES parent(id))`,
    );
    const fk = applied.tables["public.child"].constraints.find(
      (c) => c.type === "FOREIGN KEY",
    );
    expect(fk).toBeDefined();
  });

  it("handles circular foreign keys on new tables", async () => {
    const { to, applied } = await applyDiff(
      "",
      `CREATE TABLE a (id integer PRIMARY KEY, b_id integer);
       CREATE TABLE b (id integer PRIMARY KEY, a_id integer);
       ALTER TABLE a ADD CONSTRAINT a_b_fk FOREIGN KEY (b_id) REFERENCES b(id);
       ALTER TABLE b ADD CONSTRAINT b_a_fk FOREIGN KEY (a_id) REFERENCES a(id)`,
    );
    expectTablesMatch(applied, to);
  });

  it("modifies enum values", async () => {
    const { to, applied } = await applyDiff(
      `CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');
       CREATE TABLE t (id integer, m mood)`,
      `CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy', 'ecstatic');
       CREATE TABLE t (id integer, m mood)`,
    );
    expect(applied.enums["public.mood"].values).toEqual([
      "sad", "ok", "happy", "ecstatic",
    ]);
  });

  it("adds and drops an enum", async () => {
    const { to, applied } = await applyDiff(
      "",
      "CREATE TYPE status AS ENUM ('active', 'inactive')",
    );
    expect(applied.enums["public.status"]).toBeDefined();

    const { applied: applied2 } = await applyDiff(
      "CREATE TYPE status AS ENUM ('active', 'inactive')",
      "",
    );
    expect(applied2.enums["public.status"]).toBeUndefined();
  });

  it("changes a view", async () => {
    const { to, applied } = await applyDiff(
      `CREATE TABLE t (x integer, y integer);
       CREATE VIEW v AS SELECT x FROM t`,
      `CREATE TABLE t (x integer, y integer);
       CREATE VIEW v AS SELECT x, y FROM t`,
    );
    expect(applied.views["public.v"].definition).toContain("y");
  });

  it("adds and changes a function", async () => {
    const { to, applied } = await applyDiff(
      `CREATE FUNCTION f(a integer) RETURNS integer AS $$ SELECT a $$ LANGUAGE sql`,
      `CREATE FUNCTION f(a integer) RETURNS integer AS $$ SELECT a + 1 $$ LANGUAGE sql`,
    );
    expect(Object.keys(applied.functions)).toContain("public.f");
  });

  it("orders interdependent functions so callees precede callers", async () => {
    const { to, applied } = await applyDiff(
      "",
      `CREATE FUNCTION foo(i integer) RETURNS integer AS $$
         SELECT (i + 1) AS j
       $$ LANGUAGE SQL;
       CREATE FUNCTION bar(i integer) RETURNS integer AS $$
         SELECT (foo(i) + 1) AS j
       $$ LANGUAGE SQL;`,
    );
    expect(Object.keys(applied.functions)).toContain("public.foo");
    expect(Object.keys(applied.functions)).toContain("public.bar");
  });

  it("orders a view built on another view (same bucket, needs pg_depend)", async () => {
    // Adversarial names: alphabetically the dependent view sorts first, so only
    // a pg_depend edge produces the correct order.
    const { applied } = await applyDiff(
      "",
      `CREATE TABLE t (x integer);
       CREATE VIEW zzz_v1 AS SELECT x FROM t;
       CREATE VIEW aaa_v2 AS SELECT x FROM zzz_v1;`,
    );
    expect(applied.views["public.zzz_v1"]).toBeDefined();
    expect(applied.views["public.aaa_v2"]).toBeDefined();
  });

  it("orders an enum-typed column before nothing breaks (adversarial names)", async () => {
    const { applied } = await applyDiff(
      "",
      `CREATE TYPE zzz_mood AS ENUM ('sad','happy');
       CREATE TABLE aaa_people (id integer, m zzz_mood);`,
    );
    expect(applied.tables["public.aaa_people"].columns.find((c) => c.name === "m")).toBeDefined();
    expect(applied.enums["public.zzz_mood"]).toBeDefined();
  });

  it("orders a default calling a function, and a check calling a function", async () => {
    const { applied } = await applyDiff(
      "",
      `CREATE FUNCTION zzz_def() RETURNS integer AS $$ SELECT 7 $$ LANGUAGE sql;
       CREATE FUNCTION zzz_chk(i integer) RETURNS boolean AS $$ SELECT i > 0 $$ LANGUAGE sql;
       CREATE TABLE aaa_t (
         id integer,
         v integer DEFAULT zzz_def(),
         c integer CONSTRAINT c_pos CHECK (zzz_chk(c))
       );`,
    );
    const t = applied.tables["public.aaa_t"];
    expect(t.columns.find((c) => c.name === "v")).toBeDefined();
    expect(t.constraints.find((c) => c.name === "c_pos")).toBeDefined();
  });

  it("orders a trigger's function and an expression index's function", async () => {
    const { applied } = await applyDiff(
      "",
      `CREATE FUNCTION zzz_idx(t text) RETURNS text AS $$ SELECT lower(t) $$ LANGUAGE sql;
       CREATE FUNCTION zzz_trg() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;
       CREATE TABLE aaa_t (id integer, txt text);
       CREATE INDEX aaa_idx ON aaa_t (zzz_idx(txt));
       CREATE TRIGGER aaa_trigger BEFORE INSERT ON aaa_t FOR EACH ROW EXECUTE FUNCTION zzz_trg();`,
    );
    expect(Object.keys(applied.indexes)).toContain("public.aaa_idx");
    expect(Object.keys(applied.triggers).length).toBe(1);
  });

  it("handles mutually recursive functions", async () => {
    // Neither function can be created before the other exists, so the input
    // schema — like a real dump — must itself disable body validation, and the
    // diff we emit must do the same for the migration to apply.
    const { applied } = await applyDiff(
      "",
      `SET check_function_bodies = false;
       CREATE FUNCTION is_even(n integer) RETURNS boolean AS $$
         SELECT CASE WHEN n = 0 THEN true ELSE is_odd(n - 1) END
       $$ LANGUAGE SQL;
       CREATE FUNCTION is_odd(n integer) RETURNS boolean AS $$
         SELECT CASE WHEN n = 0 THEN false ELSE is_even(n - 1) END
       $$ LANGUAGE SQL;`,
    );
    expect(Object.keys(applied.functions)).toContain("public.is_even");
    expect(Object.keys(applied.functions)).toContain("public.is_odd");
  });

  it("handles function overload changes", async () => {
    const { to, applied } = await applyDiff(
      `CREATE FUNCTION f(a integer) RETURNS integer AS $$ SELECT a $$ LANGUAGE sql`,
      `CREATE FUNCTION f(a integer) RETURNS integer AS $$ SELECT a $$ LANGUAGE sql;
       CREATE FUNCTION f(a text) RETURNS text AS $$ SELECT a $$ LANGUAGE sql`,
    );
    expect(applied.functions["public.f"]).toHaveLength(2);
  });

  it("adds and drops triggers", async () => {
    const triggerSetup = `
      CREATE TABLE t (id integer);
      CREATE FUNCTION trg_fn() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;
    `;
    const { to, applied } = await applyDiff(
      triggerSetup,
      `${triggerSetup}
       CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION trg_fn()`,
    );
    expect(Object.keys(applied.triggers).length).toBe(1);
  });

  it("handles schema add and drop", async () => {
    const { applied } = await applyDiff(
      "",
      "CREATE SCHEMA myschema",
    );
    expect(applied.schemas["myschema"]).toBeDefined();
  });

  it("handles standalone sequence changes", async () => {
    const { to, applied } = await applyDiff(
      "CREATE SEQUENCE counter START WITH 1 INCREMENT BY 1",
      "CREATE SEQUENCE counter START WITH 100 INCREMENT BY 5 CYCLE",
    );
    expect(applied.sequences["public.counter"].increment).toBe("5");
    expect(applied.sequences["public.counter"].cycle).toBe(true);
  });

  it("annotated output includes hazard comments", async () => {
    const from = await schemaFromSql(db, "CREATE TABLE t (id integer, name text)");
    const to = await schemaFromSql(db, "CREATE TABLE t (id integer)");
    const annotated = diffSchemaAnnotated(from, to);
    expect(annotated).toContain("-- HAZARD (DeletesData)");
    expect(annotated).toContain("DROP COLUMN");
  });

  it("complex multi-object diff", async () => {
    const { to, applied } = await applyDiff(
      `CREATE TABLE accounts (id SERIAL PRIMARY KEY, email text UNIQUE);
       CREATE TABLE orders (id integer, account_id integer REFERENCES accounts(id));
       CREATE INDEX idx_orders_account ON orders (account_id)`,
      `CREATE TABLE accounts (id SERIAL PRIMARY KEY, email text UNIQUE, active boolean DEFAULT true);
       CREATE TABLE orders (id integer, account_id integer REFERENCES accounts(id), total numeric);
       CREATE TABLE products (id SERIAL PRIMARY KEY, name text NOT NULL);
       CREATE INDEX idx_orders_account ON orders (account_id)`,
    );
    expectTablesMatch(applied, to);
    expect(applied.tables["public.products"]).toBeDefined();
    expect(
      applied.tables["public.accounts"].columns.find((c) => c.name === "active"),
    ).toBeDefined();
  });

  it("SET NOT NULL has RequiresPopulatedTableScan hazard", async () => {
    const from = await schemaFromSql(db, "CREATE TABLE t (name text)");
    const to = await schemaFromSql(db, "CREATE TABLE t (name text NOT NULL)");
    const stmts = diffSchemaStatements(from, to);
    const setNotNull = stmts.find((s) => s.ddl.includes("SET NOT NULL"));
    expect(setNotNull).toBeDefined();
    expect(setNotNull!.hazards.some((h) => h.type === "RequiresPopulatedTableScan")).toBe(true);
  });

  it("ALTER COLUMN TYPE has AcquiresAccessExclusiveLock hazard", async () => {
    const from = await schemaFromSql(db, "CREATE TABLE t (val integer)");
    const to = await schemaFromSql(db, "CREATE TABLE t (val bigint)");
    const stmts = diffSchemaStatements(from, to);
    const alter = stmts.find((s) => s.ddl.includes("TYPE bigint"));
    expect(alter).toBeDefined();
    expect(alter!.hazards.some((h) => h.type === "AcquiresAccessExclusiveLock")).toBe(true);
  });
});
