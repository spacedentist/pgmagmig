import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffSchema } from "../src/diff.js";
import { extractSchema } from "../src/extract.js";
import { emptySchema } from "../src/types.js";
import { validateDiff } from "../src/validate.js";
import { schemaFromSql as _schemaFromSql } from "./helpers.js";

let db: PGlite;
beforeAll(async () => { db = new PGlite(); });
afterAll(async () => { await db.close(); });

const schemaFromSql = (sql: string) => _schemaFromSql(db, sql);

describe("validateDiff", () => {
  it("returns no errors for a correct diff (empty → schema)", async () => {
    const to = await schemaFromSql(`
      CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL);
      CREATE INDEX idx_name ON users (name);
    `);
    const ddl = diffSchema(emptySchema(), to);
    const errors = await validateDiff(emptySchema(), to, ddl);
    expect(errors).toEqual([]);
  });

  it("returns no errors for a correct diff (schema → schema)", async () => {
    const from = await schemaFromSql(
      "CREATE TABLE t (id integer PRIMARY KEY, name text)",
    );
    const to = await schemaFromSql(
      "CREATE TABLE t (id integer PRIMARY KEY, name text NOT NULL, email text UNIQUE)",
    );
    const ddl = diffSchema(from, to);
    const errors = await validateDiff(from, to, ddl);
    expect(errors).toEqual([]);
  });

  it("returns no errors for a correct diff (schema → empty)", async () => {
    const from = await schemaFromSql("CREATE TABLE t (id integer)");
    const ddl = diffSchema(from, emptySchema());
    const errors = await validateDiff(from, emptySchema(), ddl);
    expect(errors).toEqual([]);
  });

  it("detects a missing table when DDL is incomplete", async () => {
    const to = await schemaFromSql(`
      CREATE TABLE users (id integer);
      CREATE TABLE orders (id integer);
    `);
    const errors = await validateDiff(emptySchema(), to, "CREATE TABLE public.users (id integer)");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.includes("orders"))).toBe(true);
  });

  it("detects a wrong column type", async () => {
    const to = await schemaFromSql("CREATE TABLE t (val bigint)");
    const errors = await validateDiff(
      emptySchema(), to,
      "CREATE TABLE public.t (val integer)",
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.path.includes("dataType"))).toBe(true);
  });

  it("detects a missing constraint", async () => {
    const to = await schemaFromSql("CREATE TABLE t (id integer PRIMARY KEY)");
    const errors = await validateDiff(
      emptySchema(), to,
      "CREATE TABLE public.t (id integer NOT NULL)",
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.includes("constraint") || e.message.includes("missing"))).toBe(true);
  });

  it("detects wrong enum values", async () => {
    const to = await schemaFromSql("CREATE TYPE mood AS ENUM ('sad', 'happy')");
    const errors = await validateDiff(
      emptySchema(), to,
      "CREATE TYPE public.mood AS ENUM ('sad', 'ok', 'happy')",
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.path.includes("values"))).toBe(true);
  });

  it("works with an existing PGlite instance", async () => {
    const db = new PGlite();
    try {
      const to = await schemaFromSql(
        "CREATE TABLE users (id integer PRIMARY KEY, name text)",
      );
      const ddl = diffSchema(emptySchema(), to);
      const errors = await validateDiff(emptySchema(), to, ddl, db);
      expect(errors).toEqual([]);

      const schema = await extractSchema(db);
      expect(schema.tables["public.users"]).toBeDefined();
    } finally {
      await db.close();
    }
  });

  it("validates a complex diff roundtrip", async () => {
    const from = await schemaFromSql(`
      CREATE TYPE status AS ENUM ('active', 'inactive');
      CREATE TABLE accounts (
        id SERIAL PRIMARY KEY,
        email text NOT NULL UNIQUE,
        status status DEFAULT 'active'
      );
    `);
    const to = await schemaFromSql(`
      CREATE TYPE status AS ENUM ('active', 'inactive', 'pending');
      CREATE TABLE accounts (
        id SERIAL PRIMARY KEY,
        email text NOT NULL UNIQUE,
        name text,
        status status DEFAULT 'active'
      );
      CREATE TABLE orders (
        id SERIAL PRIMARY KEY,
        account_id integer REFERENCES accounts(id)
      );
    `);
    const ddl = diffSchema(from, to);
    const errors = await validateDiff(from, to, ddl);
    expect(errors).toEqual([]);
  });

  it("validates empty diff produces no errors", async () => {
    const schema = await schemaFromSql("CREATE TABLE t (id integer)");
    const errors = await validateDiff(schema, schema, "");
    expect(errors).toEqual([]);
  });
});
