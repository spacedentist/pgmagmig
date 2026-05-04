import { describe, it, expect } from "vitest";
import { splitSql } from "../src/split-sql.js";

describe("splitSql", () => {
  it("splits simple statements", () => {
    expect(splitSql("SELECT 1; SELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("handles trailing statement without semicolon", () => {
    expect(splitSql("SELECT 1")).toEqual(["SELECT 1"]);
  });

  it("ignores empty statements from consecutive semicolons", () => {
    expect(splitSql(";;;")).toEqual([]);
  });

  it("returns empty array for whitespace-only input", () => {
    expect(splitSql("  \n  \t  ")).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(splitSql("")).toEqual([]);
  });

  it("preserves semicolons inside single-quoted strings", () => {
    expect(splitSql("SELECT 'hello;world';")).toEqual([
      "SELECT 'hello;world'",
    ]);
  });

  it("handles escaped single quotes (doubled)", () => {
    expect(splitSql("SELECT 'it''s;fine';")).toEqual([
      "SELECT 'it''s;fine'",
    ]);
  });

  it("handles backslash escapes in strings", () => {
    expect(splitSql("SELECT E'it\\'s;fine';")).toEqual([
      "SELECT E'it\\'s;fine'",
    ]);
  });

  it("preserves semicolons inside double-quoted identifiers", () => {
    expect(splitSql('SELECT "semi;colon";')).toEqual([
      'SELECT "semi;colon"',
    ]);
  });

  it("handles escaped double quotes (doubled)", () => {
    expect(splitSql('SELECT "a""b;c";')).toEqual(['SELECT "a""b;c"']);
  });

  it("handles dollar-quoting with empty tag", () => {
    expect(
      splitSql("SELECT $$ hello; world $$;"),
    ).toEqual(["SELECT $$ hello; world $$"]);
  });

  it("handles dollar-quoting with named tag", () => {
    expect(
      splitSql("SELECT $body$ hello; world $body$;"),
    ).toEqual(["SELECT $body$ hello; world $body$"]);
  });

  it("handles CREATE FUNCTION with dollar-quoted body", () => {
    const sql = `
      CREATE FUNCTION test() RETURNS void AS $$
        BEGIN
          INSERT INTO t VALUES (1);
          INSERT INTO t VALUES (2);
        END;
      $$ LANGUAGE plpgsql;
      SELECT 1;
    `;
    const stmts = splitSql(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("CREATE FUNCTION");
    expect(stmts[0]).toContain("INSERT INTO t VALUES (1)");
    expect(stmts[1]).toBe("SELECT 1");
  });

  it("handles nested dollar quotes with different tags", () => {
    const sql = "$outer$ SELECT $inner$ ; $inner$ $outer$;";
    expect(splitSql(sql)).toEqual([
      "$outer$ SELECT $inner$ ; $inner$ $outer$",
    ]);
  });

  it("does not treat $1 as a dollar-quote", () => {
    expect(splitSql("SELECT $1; SELECT $2;")).toEqual([
      "SELECT $1",
      "SELECT $2",
    ]);
  });

  it("does not treat $ in identifiers as a dollar-quote", () => {
    expect(splitSql('SELECT "price$"; SELECT 1;')).toEqual([
      'SELECT "price$"',
      "SELECT 1",
    ]);
  });

  it("handles line comments", () => {
    expect(splitSql("SELECT 1; -- comment\nSELECT 2;")).toEqual([
      "SELECT 1",
      "-- comment\nSELECT 2",
    ]);
  });

  it("handles line comment with semicolon", () => {
    expect(splitSql("SELECT 1 -- comment with ;\n+ 2;")).toEqual([
      "SELECT 1 -- comment with ;\n+ 2",
    ]);
  });

  it("handles block comments", () => {
    expect(splitSql("SELECT /* ; */ 1;")).toEqual(["SELECT /* ; */ 1"]);
  });

  it("handles nested block comments", () => {
    expect(splitSql("SELECT /* /* nested ; */ */ 1;")).toEqual([
      "SELECT /* /* nested ; */ */ 1",
    ]);
  });

  it("handles mixed quoting styles", () => {
    const sql = `
      INSERT INTO "my;table" VALUES ('val;ue', $$ body; $$);
      SELECT 1;
    `;
    const stmts = splitSql(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain('"my;table"');
    expect(stmts[0]).toContain("'val;ue'");
    expect(stmts[0]).toContain("$$ body; $$");
    expect(stmts[1]).toBe("SELECT 1");
  });

  it("handles a complex real-world migration", () => {
    const sql = `
      CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');

      CREATE TABLE people (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        current_mood mood DEFAULT 'ok'
      );

      CREATE FUNCTION greet(person_name TEXT) RETURNS TEXT AS $$
        BEGIN
          RETURN 'Hello, ' || person_name || '!';
        END;
      $$ LANGUAGE plpgsql;

      CREATE INDEX idx_name ON people (name);
    `;
    const stmts = splitSql(sql);
    expect(stmts).toHaveLength(4);
    expect(stmts[0]).toContain("CREATE TYPE mood");
    expect(stmts[1]).toContain("CREATE TABLE people");
    expect(stmts[2]).toContain("CREATE FUNCTION greet");
    expect(stmts[3]).toContain("CREATE INDEX idx_name");
  });

  it("trims leading and trailing whitespace from statements", () => {
    expect(splitSql("  SELECT 1  ;  SELECT 2  ")).toEqual([
      "SELECT 1",
      "SELECT 2",
    ]);
  });

  it("handles statement ending at EOF without semicolon after comment", () => {
    expect(splitSql("SELECT 1 -- trailing comment")).toEqual([
      "SELECT 1 -- trailing comment",
    ]);
  });

  it("handles block comment at EOF", () => {
    expect(splitSql("SELECT 1 /* comment */")).toEqual([
      "SELECT 1 /* comment */",
    ]);
  });
});
