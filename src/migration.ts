import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { MigrationFile } from "./types.js";

// ---------------------------------------------------------------------------
// Parse a single migration YAML
// ---------------------------------------------------------------------------

export function parseMigrationYaml(
  content: string,
  filename: string,
): MigrationFile {
  const seq = parseSequenceFromFilename(filename);
  const doc = parseYaml(content) as Record<string, unknown>;

  if (!doc || typeof doc !== "object") {
    throw new Error(`${filename}: invalid YAML`);
  }

  const title = doc.title;
  if (typeof title !== "string" || !title) {
    throw new Error(`${filename}: missing or empty 'title'`);
  }

  const uuid = doc.uuid;
  if (typeof uuid !== "string" || !isValidUuid(uuid)) {
    throw new Error(`${filename}: missing or invalid 'uuid'`);
  }

  const up = doc.up;
  if (typeof up !== "string" || !up.trim()) {
    throw new Error(`${filename}: missing or empty 'up'`);
  }

  let down: string | null;
  if (!("down" in doc) || doc.down === undefined) {
    down = null;
  } else if (doc.down === null) {
    // YAML `down:` (bare, no value) parses as null — treat as empty string
    down = "";
  } else {
    down = String(doc.down);
  }

  const invalid = doc.invalid === true;

  return { sequence: seq, uuid, title, up, down, invalid: invalid || undefined, filename };
}

// ---------------------------------------------------------------------------
// Read migration directory
// ---------------------------------------------------------------------------

export async function readMigrationDirectory(
  dir: string,
  opts: { allowInvalid?: boolean } = {},
): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Migration directory not found: ${dir}`);
    }
    throw err;
  }

  const yamlFiles = entries
    .filter((f) => /^\d+\.yaml$/.test(f))
    .sort((a, b) => parseInt(a) - parseInt(b));

  if (yamlFiles.length === 0) return [];

  const migrations: MigrationFile[] = [];
  for (const file of yamlFiles) {
    const content = await readFile(join(dir, file), "utf-8");
    const migration = parseMigrationYaml(content, file);
    migrations.push(migration);
  }

  // Validate consecutive numbering from 1
  for (let i = 0; i < migrations.length; i++) {
    const expected = i + 1;
    if (migrations[i].sequence !== expected) {
      throw new Error(
        `Migration gap: expected sequence ${expected}, got ${migrations[i].sequence} (${migrations[i].filename})`,
      );
    }
  }

  // Check for invalid migrations. Review tools (e.g. verify-down) pass
  // allowInvalid to inspect work-in-progress migrations; every other command
  // treats invalid: true as a hard stop.
  if (!opts.allowInvalid) {
    for (const m of migrations) {
      if (m.invalid) {
        throw new Error(
          `Migration ${m.filename} is marked as invalid. Review and remove the 'invalid' flag before proceeding.`,
        );
      }
    }
  }

  return migrations;
}

// ---------------------------------------------------------------------------
// Write a new migration file
// ---------------------------------------------------------------------------

export async function writeMigrationFile(
  dir: string,
  opts: { title: string; up: string; down?: string | null; invalid?: boolean },
): Promise<string> {
  let existing: string[];
  try {
    existing = await readdir(dir);
  } catch {
    existing = [];
  }

  const yamlFiles = existing.filter((f) => /^\d+\.yaml$/.test(f));
  const nextSeq = yamlFiles.length + 1;
  const filename = `${String(nextSeq).padStart(4, "0")}.yaml`;
  const uuid = randomUUID();

  const content = formatMigrationYaml({
    title: opts.title,
    uuid,
    up: opts.up,
    down: opts.down ?? null,
    invalid: opts.invalid,
  });

  await writeFile(join(dir, filename), content, "utf-8");
  return filename;
}

// ---------------------------------------------------------------------------
// Format migration YAML
// ---------------------------------------------------------------------------

export function formatMigrationYaml(opts: {
  title: string;
  uuid: string;
  up: string;
  down: string | null;
  invalid?: boolean;
}): string {
  const doc: Record<string, unknown> = {
    title: opts.title,
    uuid: opts.uuid,
  };

  if (opts.invalid) {
    doc.invalid = true;
  }

  doc.up = opts.up;

  if (opts.down !== null && opts.down !== undefined) {
    doc.down = opts.down;
  }

  return stringifyYaml(doc, {
    lineWidth: 0,
    blockQuote: "literal",
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseSequenceFromFilename(filename: string): number {
  const match = filename.match(/^(\d+)\.yaml$/);
  if (!match) {
    throw new Error(`Invalid migration filename: ${filename} (expected NNNN.yaml)`);
  }
  return parseInt(match[1], 10);
}

function isValidUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
