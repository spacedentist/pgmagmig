import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  migrate,
  planMigration,
  readAppliedMigrations,
  RollbackRequiredError,
  validateManagementTableName,
} from "../src/runner.js";
import type { MigrationFile } from "../src/types.js";

const TABLE = "public.schema_migrations";
const CREATE_TABLE_SQL = `
  CREATE TABLE ${TABLE} (
    sequence int PRIMARY KEY,
    uuid uuid NOT NULL,
    title text NOT NULL,
    down text
  )
`;

function mkFile(seq: number, opts?: Partial<MigrationFile>): MigrationFile {
  return {
    sequence: seq,
    uuid: `00000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
    title: opts?.title ?? `Migration ${seq}`,
    up: opts?.up ?? `CREATE TABLE t${seq} (id integer)`,
    down: opts?.down !== undefined ? opts.down : `DROP TABLE t${seq}`,
    filename: `${String(seq).padStart(4, "0")}.yaml`,
    ...opts,
  };
}

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  await db.query("DROP SCHEMA public CASCADE");
  await db.query("CREATE SCHEMA public");
});

// ---------------------------------------------------------------------------
// validateManagementTableName
// ---------------------------------------------------------------------------

describe("validateManagementTableName", () => {
  it("accepts simple names", () => {
    expect(() => validateManagementTableName("schema_migrations")).not.toThrow();
    expect(() => validateManagementTableName("public.schema_migrations")).not.toThrow();
  });

  it("accepts quoted names", () => {
    expect(() => validateManagementTableName('"My Migrations"')).not.toThrow();
    expect(() => validateManagementTableName('"schema"."migrations"')).not.toThrow();
  });

  it("rejects injection attempts", () => {
    expect(() => validateManagementTableName("table; DROP TABLE users")).toThrow();
    expect(() => validateManagementTableName("table--comment")).toThrow();
    expect(() => validateManagementTableName("")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// planMigration
// ---------------------------------------------------------------------------

describe("planMigration", () => {
  it("plans applying all files when nothing applied", () => {
    const files = [mkFile(1), mkFile(2), mkFile(3)];
    const plan = planMigration(files, []);
    expect(plan.toRollback).toEqual([]);
    expect(plan.toApply).toHaveLength(3);
    expect(plan.toApply[0].sequence).toBe(1);
  });

  it("plans nothing when fully up to date", () => {
    const files = [mkFile(1), mkFile(2)];
    const applied = [
      { sequence: 1, uuid: files[0].uuid, title: "m1", down: null },
      { sequence: 2, uuid: files[1].uuid, title: "m2", down: null },
    ];
    const plan = planMigration(files, applied);
    expect(plan.toRollback).toEqual([]);
    expect(plan.toApply).toEqual([]);
  });

  it("plans applying new migrations", () => {
    const files = [mkFile(1), mkFile(2), mkFile(3)];
    const applied = [
      { sequence: 1, uuid: files[0].uuid, title: "m1", down: null },
      { sequence: 2, uuid: files[1].uuid, title: "m2", down: null },
    ];
    const plan = planMigration(files, applied);
    expect(plan.toRollback).toEqual([]);
    expect(plan.toApply).toHaveLength(1);
    expect(plan.toApply[0].sequence).toBe(3);
  });

  it("plans branch switch (rollback + apply)", () => {
    const files = [mkFile(1), mkFile(2, { uuid: "aaaaaaaa-0000-0000-0000-000000000002" })];
    const applied = [
      { sequence: 1, uuid: files[0].uuid, title: "m1", down: "DROP TABLE t1" },
      { sequence: 2, uuid: "bbbbbbbb-0000-0000-0000-000000000002", title: "m2", down: "DROP TABLE old" },
    ];
    const plan = planMigration(files, applied);
    expect(plan.toRollback).toHaveLength(1);
    expect(plan.toRollback[0].sequence).toBe(2);
    expect(plan.toApply).toHaveLength(1);
    expect(plan.toApply[0].sequence).toBe(2);
  });

  it("plans full rollback", () => {
    const files = [mkFile(1)];
    const applied = [
      { sequence: 1, uuid: files[0].uuid, title: "m1", down: "d1" },
      { sequence: 2, uuid: "extra-uuid-0000-0000-000000000000", title: "m2", down: "d2" },
      { sequence: 3, uuid: "extra-uuid-0000-0000-000000000001", title: "m3", down: "d3" },
    ];
    const plan = planMigration(files, applied);
    expect(plan.toRollback).toHaveLength(2);
    expect(plan.toRollback[0].sequence).toBe(3); // reverse order
    expect(plan.toRollback[1].sequence).toBe(2);
    expect(plan.toApply).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// readAppliedMigrations
// ---------------------------------------------------------------------------

describe("readAppliedMigrations", () => {
  it("returns empty when allowMissing and table doesn't exist", async () => {
    const result = await readAppliedMigrations(db, TABLE, true);
    expect(result).toEqual([]);
  });

  it("throws when table doesn't exist and allowMissing is false", async () => {
    await expect(readAppliedMigrations(db, TABLE, false)).rejects.toThrow();
  });

  it("reads applied migrations in order", async () => {
    await db.query(CREATE_TABLE_SQL);
    await db.query(
      `INSERT INTO ${TABLE} VALUES (1, '00000000-0000-0000-0000-000000000001', 'first', 'DROP TABLE t1')`,
    );
    await db.query(
      `INSERT INTO ${TABLE} VALUES (2, '00000000-0000-0000-0000-000000000002', 'second', NULL)`,
    );
    const result = await readAppliedMigrations(db, TABLE, false);
    expect(result).toHaveLength(2);
    expect(result[0].sequence).toBe(1);
    expect(result[0].down).toBe("DROP TABLE t1");
    expect(result[1].sequence).toBe(2);
    expect(result[1].down).toBeNull();
  });

  it("detects sequence gap as corruption", async () => {
    await db.query(CREATE_TABLE_SQL);
    await db.query(
      `INSERT INTO ${TABLE} VALUES (1, '00000000-0000-0000-0000-000000000001', 'first', NULL)`,
    );
    await db.query(
      `INSERT INTO ${TABLE} VALUES (3, '00000000-0000-0000-0000-000000000003', 'third', NULL)`,
    );
    await expect(readAppliedMigrations(db, TABLE, false)).rejects.toThrow(
      "corruption",
    );
  });
});

// ---------------------------------------------------------------------------
// migrate (full integration)
// ---------------------------------------------------------------------------

describe("migrate", () => {
  it("applies first migration (bootstrap)", async () => {
    const files = [
      mkFile(1, {
        up: CREATE_TABLE_SQL,
        down: `DROP TABLE ${TABLE}`,
      }),
    ];

    const result = await migrate({
      db,
      files,
      managementTable: TABLE,
      allowMissingManagementTable: true,
    });

    expect(result.applied).toHaveLength(1);
    expect(result.rolledBack).toHaveLength(0);

    const applied = await readAppliedMigrations(db, TABLE, false);
    expect(applied).toHaveLength(1);
    expect(applied[0].title).toBe("Migration 1");
  });

  it("applies multiple migrations", async () => {
    const files = [
      mkFile(1, { up: CREATE_TABLE_SQL, down: `DROP TABLE ${TABLE}` }),
      mkFile(2, { up: "CREATE TABLE users (id integer)", down: "DROP TABLE users" }),
      mkFile(3, { up: "CREATE TABLE orders (id integer)", down: "DROP TABLE orders" }),
    ];

    const result = await migrate({
      db,
      files,
      managementTable: TABLE,
      allowMissingManagementTable: true,
    });

    expect(result.applied).toHaveLength(3);
    const applied = await readAppliedMigrations(db, TABLE, false);
    expect(applied).toHaveLength(3);

    // Verify tables exist
    const { rows } = await db.query<{ name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'",
    );
    const names = rows.map((r) => r.name);
    expect(names).toContain("schema_migrations");
    expect(names).toContain("users");
    expect(names).toContain("orders");
  });

  it("rolls back and reapplies on branch switch", async () => {
    // Apply original migrations
    const filesV1 = [
      mkFile(1, { up: CREATE_TABLE_SQL, down: `DROP TABLE ${TABLE}` }),
      mkFile(2, { up: "CREATE TABLE old_table (id integer)", down: "DROP TABLE old_table" }),
    ];
    await migrate({
      db, files: filesV1, managementTable: TABLE,
      allowMissingManagementTable: true,
    });

    // Switch branch: same first migration, different second
    const filesV2 = [
      mkFile(1, { up: CREATE_TABLE_SQL, down: `DROP TABLE ${TABLE}` }),
      mkFile(2, {
        uuid: "aaaaaaaa-0000-0000-0000-000000000002",
        up: "CREATE TABLE new_table (id integer)",
        down: "DROP TABLE new_table",
      }),
    ];
    const result = await migrate({
      db, files: filesV2, managementTable: TABLE,
      allowRollback: true,
    });

    expect(result.rolledBack).toHaveLength(1);
    expect(result.applied).toHaveLength(1);

    // old_table should be gone, new_table should exist
    const { rows } = await db.query<{ name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'",
    );
    const names = rows.map((r) => r.name);
    expect(names).not.toContain("old_table");
    expect(names).toContain("new_table");
  });

  it("errors on rollback with no down SQL", async () => {
    const files = [
      mkFile(1, { up: CREATE_TABLE_SQL, down: `DROP TABLE ${TABLE}` }),
      mkFile(2, { up: "SELECT 1", down: null }),
    ];
    await migrate({
      db, files, managementTable: TABLE,
      allowMissingManagementTable: true,
    });

    // Try to rollback by providing only file 1
    const files2 = [
      mkFile(1, { up: CREATE_TABLE_SQL, down: `DROP TABLE ${TABLE}` }),
    ];
    await expect(
      migrate({ db, files: files2, managementTable: TABLE, allowRollback: true }),
    ).rejects.toThrow("no down migration");
  });

  it("errors when rollback needed but --allow-rollback not set", async () => {
    const files = [
      mkFile(1, { up: CREATE_TABLE_SQL, down: `DROP TABLE ${TABLE}` }),
      mkFile(2, { up: "SELECT 1", down: "SELECT 1" }),
    ];
    await migrate({
      db, files, managementTable: TABLE,
      allowMissingManagementTable: true,
    });

    const files2 = [
      mkFile(1, { up: CREATE_TABLE_SQL, down: `DROP TABLE ${TABLE}` }),
    ];
    await expect(
      migrate({ db, files: files2, managementTable: TABLE }),
    ).rejects.toThrow(RollbackRequiredError);
  });

  it("handles rollback with empty down (no-op)", async () => {
    const files = [
      mkFile(1, { up: CREATE_TABLE_SQL, down: `DROP TABLE ${TABLE}` }),
      mkFile(2, { up: "SELECT 1", down: "" }),
    ];
    await migrate({
      db, files, managementTable: TABLE,
      allowMissingManagementTable: true,
    });

    // Rollback migration 2 (empty down = no-op, just removes the row)
    const files2 = [
      mkFile(1, { up: CREATE_TABLE_SQL, down: `DROP TABLE ${TABLE}` }),
    ];
    const result = await migrate({ db, files: files2, managementTable: TABLE, allowRollback: true });
    expect(result.rolledBack).toHaveLength(1);

    const applied = await readAppliedMigrations(db, TABLE, false);
    expect(applied).toHaveLength(1);
  });

  it("dry run does not modify database", async () => {
    const files = [
      mkFile(1, { up: CREATE_TABLE_SQL, down: `DROP TABLE ${TABLE}` }),
    ];

    const result = await migrate({
      db, files, managementTable: TABLE,
      allowMissingManagementTable: true,
      dryRun: true,
    });

    expect(result.pending).toBe(true);
    expect(result.applied).toHaveLength(0);

    // Management table should NOT exist
    await expect(readAppliedMigrations(db, TABLE, false)).rejects.toThrow();
  });

  it("check mode reports pending", async () => {
    const files = [
      mkFile(1, { up: CREATE_TABLE_SQL, down: `DROP TABLE ${TABLE}` }),
    ];

    const result = await migrate({
      db, files, managementTable: TABLE,
      allowMissingManagementTable: true,
      check: true,
    });

    expect(result.pending).toBe(true);
    expect(result.applied).toHaveLength(0);
  });

  it("reports not pending when up to date", async () => {
    const files = [
      mkFile(1, { up: CREATE_TABLE_SQL, down: `DROP TABLE ${TABLE}` }),
    ];
    await migrate({
      db, files, managementTable: TABLE,
      allowMissingManagementTable: true,
    });

    const result = await migrate({
      db, files, managementTable: TABLE,
      check: true,
    });

    expect(result.pending).toBe(false);
  });

  it("rolls back transaction on SQL error", async () => {
    const files = [
      mkFile(1, { up: CREATE_TABLE_SQL, down: `DROP TABLE ${TABLE}` }),
      mkFile(2, { up: "INVALID SQL STATEMENT", down: "SELECT 1" }),
    ];

    await migrate({
      db, files: [files[0]], managementTable: TABLE,
      allowMissingManagementTable: true,
    });

    await expect(
      migrate({ db, files, managementTable: TABLE }),
    ).rejects.toThrow();

    // Only migration 1 should remain applied
    const applied = await readAppliedMigrations(db, TABLE, false);
    expect(applied).toHaveLength(1);
  });
});
