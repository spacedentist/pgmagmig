import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { serve, runWithEphemeralDb } from "../src/serve.js";

describe("serve", () => {
  it("defaults to Unix domain socket", async () => {
    const db = new PGlite();
    try {
      const { connectionString, close } = await serve({ pglite: db });
      try {
        expect(connectionString).toContain("host=");
        expect(connectionString).toContain("pgmagmig-");

        const client = new pg.Client({ connectionString });
        await client.connect();
        try {
          const result = await client.query("SELECT 1 AS v");
          expect(result.rows[0].v).toBe(1);
        } finally {
          await client.end();
        }
      } finally {
        await close();
      }
    } finally {
      await db.close();
    }
  });

  it("uses TCP when host is specified", async () => {
    const db = new PGlite();
    try {
      const { connectionString, close } = await serve({
        pglite: db,
        host: "127.0.0.1",
      });
      try {
        expect(connectionString).toContain("127.0.0.1");
        expect(connectionString).toMatch(/postgresql:\/\//);

        const client = new pg.Client({ connectionString });
        await client.connect();
        try {
          const result = await client.query("SELECT 1 AS v");
          expect(result.rows[0].v).toBe(1);
        } finally {
          await client.end();
        }
      } finally {
        await close();
      }
    } finally {
      await db.close();
    }
  });

  it("schema is accessible over UDS", async () => {
    const db = new PGlite();
    try {
      await db.query("CREATE TABLE test_table (id integer, name text)");
      await db.query("INSERT INTO test_table VALUES (1, 'hello')");

      const { connectionString, close } = await serve({ pglite: db });
      try {
        const client = new pg.Client({ connectionString });
        await client.connect();
        try {
          const result = await client.query("SELECT * FROM test_table");
          expect(result.rows).toEqual([{ id: 1, name: "hello" }]);
        } finally {
          await client.end();
        }
      } finally {
        await close();
      }
    } finally {
      await db.close();
    }
  });
});

describe("runWithEphemeralDb", () => {
  it("runs a command with DATABASE_URL set (UDS by default)", async () => {
    const exitCode = await runWithEphemeralDb({
      sqlStatements: ["CREATE TABLE t (id integer)"],
      command: 'echo "DATABASE_URL=$DATABASE_URL"',
    });
    expect(exitCode).toBe(0);
  });

  it("propagates non-zero exit code", async () => {
    const exitCode = await runWithEphemeralDb({
      sqlStatements: [],
      command: "exit 42",
    });
    expect(exitCode).toBe(42);
  });

  it("schema is queryable from child process via UDS", async () => {
    const exitCode = await runWithEphemeralDb({
      sqlStatements: [
        "CREATE TABLE users (id integer PRIMARY KEY, name text)",
        "INSERT INTO users VALUES (1, 'test')",
      ],
      command: `node -e "
        const pg = require('pg');
        const c = new pg.Client(process.env.DATABASE_URL);
        c.connect().then(() => c.query('SELECT count(*)::int AS n FROM users'))
          .then(r => { process.exit(r.rows[0].n === 1 ? 0 : 1); })
          .catch(() => process.exit(2));
      "`,
    });
    expect(exitCode).toBe(0);
  });

  it("works with TCP when host is specified", async () => {
    const exitCode = await runWithEphemeralDb({
      sqlStatements: ["CREATE TABLE t (id integer)"],
      host: "127.0.0.1",
      command: `node -e "
        const pg = require('pg');
        const c = new pg.Client(process.env.DATABASE_URL);
        c.connect().then(() => c.query('SELECT 1'))
          .then(() => { c.end(); process.exit(0); })
          .catch(() => process.exit(1));
      "`,
    });
    expect(exitCode).toBe(0);
  });
});
