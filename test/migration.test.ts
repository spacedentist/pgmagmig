import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatMigrationYaml,
  parseMigrationYaml,
  readMigrationDirectory,
  writeMigrationFile,
} from "../src/migration.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pgmagmig-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeYaml(filename: string, content: string) {
  await writeFile(join(dir, filename), content, "utf-8");
}

// ---------------------------------------------------------------------------
// parseMigrationYaml
// ---------------------------------------------------------------------------

describe("parseMigrationYaml", () => {
  it("parses a complete migration", () => {
    const m = parseMigrationYaml(
      `title: Create users\nuuid: 7f3b2a1e-8c4d-4e5f-9a6b-1c2d3e4f5a6b\nup: |\n  CREATE TABLE users (id int);\ndown: |\n  DROP TABLE users;\n`,
      "0001.yaml",
    );
    expect(m.sequence).toBe(1);
    expect(m.title).toBe("Create users");
    expect(m.uuid).toBe("7f3b2a1e-8c4d-4e5f-9a6b-1c2d3e4f5a6b");
    expect(m.up).toContain("CREATE TABLE");
    expect(m.down).toContain("DROP TABLE");
    expect(m.invalid).toBeUndefined();
    expect(m.filename).toBe("0001.yaml");
  });

  it("parses minimal migration (no down)", () => {
    const m = parseMigrationYaml(
      `title: Create users\nuuid: 7f3b2a1e-8c4d-4e5f-9a6b-1c2d3e4f5a6b\nup: SELECT 1;\n`,
      "0001.yaml",
    );
    expect(m.down).toBeNull();
  });

  it("parses empty down as empty string", () => {
    const m = parseMigrationYaml(
      `title: t\nuuid: 7f3b2a1e-8c4d-4e5f-9a6b-1c2d3e4f5a6b\nup: SELECT 1;\ndown: ""\n`,
      "0001.yaml",
    );
    expect(m.down).toBe("");
  });

  it("parses down: (bare) as empty string", () => {
    const m = parseMigrationYaml(
      `title: t\nuuid: 7f3b2a1e-8c4d-4e5f-9a6b-1c2d3e4f5a6b\nup: SELECT 1;\ndown:\n`,
      "0001.yaml",
    );
    expect(m.down).toBe("");
  });

  it("preserves invalid: true", () => {
    const m = parseMigrationYaml(
      `title: t\nuuid: 7f3b2a1e-8c4d-4e5f-9a6b-1c2d3e4f5a6b\ninvalid: true\nup: SELECT 1;\n`,
      "0001.yaml",
    );
    expect(m.invalid).toBe(true);
  });

  it("throws on missing title", () => {
    expect(() =>
      parseMigrationYaml(
        `uuid: 7f3b2a1e-8c4d-4e5f-9a6b-1c2d3e4f5a6b\nup: SELECT 1;\n`,
        "0001.yaml",
      ),
    ).toThrow("title");
  });

  it("throws on missing uuid", () => {
    expect(() =>
      parseMigrationYaml(`title: t\nup: SELECT 1;\n`, "0001.yaml"),
    ).toThrow("uuid");
  });

  it("throws on invalid uuid format", () => {
    expect(() =>
      parseMigrationYaml(
        `title: t\nuuid: not-a-uuid\nup: SELECT 1;\n`,
        "0001.yaml",
      ),
    ).toThrow("uuid");
  });

  it("throws on missing up", () => {
    expect(() =>
      parseMigrationYaml(
        `title: t\nuuid: 7f3b2a1e-8c4d-4e5f-9a6b-1c2d3e4f5a6b\n`,
        "0001.yaml",
      ),
    ).toThrow("up");
  });

  it("throws on invalid filename", () => {
    expect(() =>
      parseMigrationYaml(
        `title: t\nuuid: 7f3b2a1e-8c4d-4e5f-9a6b-1c2d3e4f5a6b\nup: SELECT 1;\n`,
        "bad.yaml",
      ),
    ).toThrow("filename");
  });

  it("parses sequence from multi-digit filenames", () => {
    const m = parseMigrationYaml(
      `title: t\nuuid: 7f3b2a1e-8c4d-4e5f-9a6b-1c2d3e4f5a6b\nup: SELECT 1;\n`,
      "0042.yaml",
    );
    expect(m.sequence).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// readMigrationDirectory
// ---------------------------------------------------------------------------

describe("readMigrationDirectory", () => {
  it("reads an empty directory", async () => {
    const result = await readMigrationDirectory(dir);
    expect(result).toEqual([]);
  });

  it("reads migrations in sequence order", async () => {
    await writeYaml("0001.yaml", `title: First\nuuid: 7f3b2a1e-8c4d-4e5f-9a6b-1c2d3e4f5a6b\nup: SELECT 1;\n`);
    await writeYaml("0002.yaml", `title: Second\nuuid: 8f3b2a1e-8c4d-4e5f-9a6b-1c2d3e4f5a6b\nup: SELECT 2;\n`);
    await writeYaml("0003.yaml", `title: Third\nuuid: 9f3b2a1e-8c4d-4e5f-9a6b-1c2d3e4f5a6b\nup: SELECT 3;\n`);

    const result = await readMigrationDirectory(dir);
    expect(result).toHaveLength(3);
    expect(result[0].sequence).toBe(1);
    expect(result[1].sequence).toBe(2);
    expect(result[2].sequence).toBe(3);
  });

  it("throws on gap in sequence", async () => {
    await writeYaml("0001.yaml", `title: t\nuuid: 7f3b2a1e-8c4d-4e5f-9a6b-1c2d3e4f5a6b\nup: SELECT 1;\n`);
    await writeYaml("0003.yaml", `title: t\nuuid: 9f3b2a1e-8c4d-4e5f-9a6b-1c2d3e4f5a6b\nup: SELECT 3;\n`);

    await expect(readMigrationDirectory(dir)).rejects.toThrow("gap");
  });

  it("throws on invalid migration", async () => {
    await writeYaml(
      "0001.yaml",
      `title: t\nuuid: 7f3b2a1e-8c4d-4e5f-9a6b-1c2d3e4f5a6b\ninvalid: true\nup: SELECT 1;\n`,
    );

    await expect(readMigrationDirectory(dir)).rejects.toThrow("invalid");
  });

  it("reads invalid migrations when allowInvalid is set", async () => {
    await writeYaml(
      "0001.yaml",
      `title: t\nuuid: 7f3b2a1e-8c4d-4e5f-9a6b-1c2d3e4f5a6b\ninvalid: true\nup: SELECT 1;\n`,
    );

    const result = await readMigrationDirectory(dir, { allowInvalid: true });
    expect(result).toHaveLength(1);
    expect(result[0].invalid).toBe(true);
  });

  it("throws on missing directory", async () => {
    await expect(readMigrationDirectory("/nonexistent/path")).rejects.toThrow(
      "not found",
    );
  });

  it("ignores non-yaml files", async () => {
    await writeYaml("0001.yaml", `title: t\nuuid: 7f3b2a1e-8c4d-4e5f-9a6b-1c2d3e4f5a6b\nup: SELECT 1;\n`);
    await writeFile(join(dir, "README.md"), "ignore me", "utf-8");
    await writeFile(join(dir, ".gitkeep"), "", "utf-8");

    const result = await readMigrationDirectory(dir);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// writeMigrationFile
// ---------------------------------------------------------------------------

describe("writeMigrationFile", () => {
  it("writes 0001.yaml to empty directory", async () => {
    const filename = await writeMigrationFile(dir, {
      title: "Create users",
      up: "CREATE TABLE users (id int);",
      down: "DROP TABLE users;",
    });

    expect(filename).toBe("0001.yaml");
    const content = await readFile(join(dir, filename), "utf-8");
    expect(content).toContain("Create users");
    expect(content).toContain("CREATE TABLE");
    expect(content).toContain("DROP TABLE");
  });

  it("writes sequential files", async () => {
    await writeMigrationFile(dir, { title: "First", up: "SELECT 1;" });
    await writeMigrationFile(dir, { title: "Second", up: "SELECT 2;" });
    const third = await writeMigrationFile(dir, { title: "Third", up: "SELECT 3;" });

    expect(third).toBe("0003.yaml");
  });

  it("includes invalid marker when requested", async () => {
    const filename = await writeMigrationFile(dir, {
      title: "Draft",
      up: "SELECT 1;",
      invalid: true,
    });

    const content = await readFile(join(dir, filename), "utf-8");
    expect(content).toContain("invalid: true");
  });

  it("generates a valid UUID", async () => {
    const filename = await writeMigrationFile(dir, {
      title: "Test",
      up: "SELECT 1;",
    });

    const content = await readFile(join(dir, filename), "utf-8");
    const uuidMatch = content.match(
      /uuid: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
    );
    expect(uuidMatch).not.toBeNull();
  });

  it("omits down when null", async () => {
    const filename = await writeMigrationFile(dir, {
      title: "No down",
      up: "SELECT 1;",
      down: null,
    });

    const content = await readFile(join(dir, filename), "utf-8");
    expect(content).not.toContain("down:");
  });

  it("includes empty down", async () => {
    const filename = await writeMigrationFile(dir, {
      title: "Empty down",
      up: "SELECT 1;",
      down: "",
    });

    const content = await readFile(join(dir, filename), "utf-8");
    expect(content).toContain("down:");
  });
});

// ---------------------------------------------------------------------------
// formatMigrationYaml
// ---------------------------------------------------------------------------

describe("formatMigrationYaml", () => {
  it("roundtrips through parse", () => {
    const yaml = formatMigrationYaml({
      title: "Create users",
      uuid: "7f3b2a1e-8c4d-4e5f-9a6b-1c2d3e4f5a6b",
      up: "CREATE TABLE users (id int);\n",
      down: "DROP TABLE users;\n",
    });

    const parsed = parseMigrationYaml(yaml, "0001.yaml");
    expect(parsed.title).toBe("Create users");
    expect(parsed.uuid).toBe("7f3b2a1e-8c4d-4e5f-9a6b-1c2d3e4f5a6b");
    expect(parsed.up).toContain("CREATE TABLE");
    expect(parsed.down).toContain("DROP TABLE");
  });

  it("roundtrips with no down", () => {
    const yaml = formatMigrationYaml({
      title: "t",
      uuid: "7f3b2a1e-8c4d-4e5f-9a6b-1c2d3e4f5a6b",
      up: "SELECT 1;\n",
      down: null,
    });

    const parsed = parseMigrationYaml(yaml, "0001.yaml");
    expect(parsed.down).toBeNull();
  });
});
