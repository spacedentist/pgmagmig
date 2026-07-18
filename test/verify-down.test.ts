import { describe, expect, it } from "vitest";
import { verifyDownMigrations } from "../src/verify-down.js";
import type { MigrationFile } from "../src/types.js";

let uuidCounter = 0;
function mig(
  sequence: number,
  up: string,
  down: string | null,
  extra: Partial<MigrationFile> = {},
): MigrationFile {
  uuidCounter++;
  const uuid = `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
  return {
    sequence,
    uuid,
    title: `migration ${sequence}`,
    up,
    down,
    filename: `${String(sequence).padStart(4, "0")}.yaml`,
    ...extra,
  };
}

describe("verifyDownMigrations", () => {
  it("passes a correct down migration", async () => {
    const migs = [
      mig(1, "CREATE TABLE t (id integer)", "DROP TABLE t"),
      mig(2, "ALTER TABLE t ADD COLUMN name text", "ALTER TABLE t DROP COLUMN name"),
    ];
    const { checks, ok } = await verifyDownMigrations(migs, { count: 2 });
    expect(ok).toBe(true);
    expect(checks.map((c) => c.status)).toEqual(["ok", "ok"]);
  });

  it("defaults to checking only the last migration", async () => {
    const migs = [
      mig(1, "CREATE TABLE t (id integer)", "DROP TABLE t"),
      mig(2, "ALTER TABLE t ADD COLUMN name text", "ALTER TABLE t DROP COLUMN name"),
    ];
    const { checks } = await verifyDownMigrations(migs); // count defaults to 1
    expect(checks).toHaveLength(1);
    expect(checks[0].sequence).toBe(2);
    expect(checks[0].status).toBe("ok");
  });

  it("detects a down that does not fully restore the schema", async () => {
    // The down forgets to drop the added column.
    const migs = [
      mig(1, "CREATE TABLE t (id integer)", "DROP TABLE t"),
      mig(2, "ALTER TABLE t ADD COLUMN name text", "SELECT 1"),
    ];
    const { checks, ok } = await verifyDownMigrations(migs, { count: 1 });
    expect(ok).toBe(false);
    expect(checks[0].status).toBe("down-mismatch");
    expect(checks[0].errors?.some((e) => e.message.includes("name"))).toBe(true);
  });

  it("detects a down that over-drops (removes a pre-existing column)", async () => {
    // The down drops more than the up added: `keep` existed before this
    // migration, so the down leaves the schema missing it.
    const migs = [
      mig(1, "CREATE TABLE t (id integer, keep text)", "DROP TABLE t"),
      mig(
        2,
        "ALTER TABLE t ADD COLUMN name text",
        "ALTER TABLE t DROP COLUMN name; ALTER TABLE t DROP COLUMN keep",
      ),
    ];
    const { checks, ok } = await verifyDownMigrations(migs, { count: 1 });
    expect(ok).toBe(false);
    expect(checks[0].status).toBe("down-mismatch");
    expect(checks[0].errors?.some((e) => e.message.includes("keep"))).toBe(true);
  });

  it("reports a down that fails to execute", async () => {
    const migs = [
      mig(1, "CREATE TABLE t (id integer)", "DROP TABLE t"),
      mig(2, "ALTER TABLE t ADD COLUMN name text", "DROP TABLE does_not_exist"),
    ];
    const { checks, ok } = await verifyDownMigrations(migs, { count: 1 });
    expect(ok).toBe(false);
    expect(checks[0].status).toBe("down-error");
    expect(checks[0].message).toMatch(/does_not_exist/);
  });

  it("skips migrations with no down (null) and no-op downs (empty)", async () => {
    const migs = [
      mig(1, "CREATE TABLE t (id integer)", null),
      mig(2, "INSERT INTO t VALUES (1)", ""),
    ];
    const { checks, ok } = await verifyDownMigrations(migs, { count: 2 });
    expect(ok).toBe(true);
    expect(checks.map((c) => c.status)).toEqual(["no-down", "noop-down"]);
  });

  it("checks the last N when asked, building base state from earlier ups", async () => {
    const migs = [
      mig(1, "CREATE TABLE a (id integer)", "DROP TABLE a"),
      mig(2, "CREATE TABLE b (id integer)", "DROP TABLE b"),
      mig(3, "CREATE TABLE c (id integer)", "DROP TABLE c"),
    ];
    // Only check the last 2; migration 1 is applied as base state.
    const { checks, ok } = await verifyDownMigrations(migs, { count: 2 });
    expect(ok).toBe(true);
    expect(checks.map((c) => c.sequence)).toEqual([2, 3]);
  });

  it("verifies interdependent-view migrations (down restores exactly)", async () => {
    const migs = [
      mig(
        1,
        `CREATE TABLE t (x integer, y integer);
         CREATE VIEW base AS SELECT x, y FROM t;
         CREATE VIEW top AS SELECT x FROM base`,
        `DROP VIEW top; DROP VIEW base; DROP TABLE t`,
      ),
    ];
    const { checks, ok } = await verifyDownMigrations(migs, { count: 1 });
    expect(ok).toBe(true);
    expect(checks[0].status).toBe("ok");
  });
});
