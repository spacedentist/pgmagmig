import { readFile } from "node:fs/promises";
import { Command } from "commander";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { extractSchema, extractSchemaFromSql, extractSchemaFromDatabase } from "./extract.js";
import { generateDdl } from "./generate.js";
import { diffSchema, diffSchemaAnnotated, diffSchemaStatements } from "./diff.js";
import { validateDiff } from "./validate.js";
import { readMigrationDirectory, writeMigrationFile } from "./migration.js";
import { migrate, MigrationError } from "./runner.js";
import { runWithEphemeralDb } from "./serve.js";
import { splitSql } from "./split-sql.js";
import type { DatabaseSchema } from "./types.js";
import { emptySchema } from "./types.js";

// ---------------------------------------------------------------------------
// Schema source resolution
// ---------------------------------------------------------------------------

interface SchemaSourceOpts {
  sql?: string[];
  json?: string;
  empty?: boolean;
  database?: string;
  migrationsDir?: string;
}

async function resolveSchema(
  opts: SchemaSourceOpts,
  label: string,
): Promise<DatabaseSchema> {
  const sources = [opts.sql, opts.json, opts.empty, opts.database, opts.migrationsDir].filter(Boolean);
  if (sources.length === 0) {
    throw new Error(`No ${label} schema source specified. Use --${label}-sql, --${label}-json, --${label}-empty, --${label}-database, or --${label}-migrations-dir.`);
  }
  if (sources.length > 1) {
    throw new Error(`Multiple ${label} schema sources specified. Use exactly one.`);
  }

  if (opts.empty) {
    return emptySchema();
  }

  if (opts.json) {
    const content = await readFile(opts.json, "utf-8");
    return JSON.parse(content) as DatabaseSchema;
  }

  if (opts.sql) {
    const sqls: string[] = [];
    for (const file of opts.sql) {
      sqls.push(await readFile(file, "utf-8"));
    }
    return extractSchemaFromSql(sqls);
  }

  if (opts.database) {
    return extractSchemaFromDatabase(opts.database);
  }

  if (opts.migrationsDir) {
    const migrations = await readMigrationDirectory(opts.migrationsDir);
    if (migrations.length === 0) return emptySchema();
    const db = new PGlite();
    try {
      for (const m of migrations) {
        for (const stmt of splitSql(m.up)) {
          await db.query(stmt);
        }
      }
      return await extractSchema(db);
    } finally {
      await db.close();
    }
  }

  throw new Error("Unreachable");
}

async function resolveToSql(
  opts: SchemaSourceOpts,
  label: string,
): Promise<string[]> {
  if (opts.sql) {
    const sqls: string[] = [];
    for (const file of opts.sql) {
      sqls.push(await readFile(file, "utf-8"));
    }
    return sqls;
  }
  if (opts.migrationsDir) {
    const migrations = await readMigrationDirectory(opts.migrationsDir);
    return migrations.map((m) => m.up);
  }
  if (opts.empty) {
    return [];
  }
  // For JSON and database sources, resolve to schema then generate DDL
  const schema = await resolveSchema(opts, label);
  const ddl = generateDdl(schema);
  return ddl ? [ddl] : [];
}

function addFromOptions(cmd: Command): Command {
  return cmd
    .option("--from-sql <files...>", "SQL files (order matters)")
    .option("--from-json <file>", "JSON schema file")
    .option("--from-empty", "empty schema")
    .option("--from-database <url>", "database connection URL (read-only)")
    .option("--from-migrations-dir <path>", "migrations directory");
}

function addToOptions(cmd: Command): Command {
  return cmd
    .option("--to-sql <files...>", "SQL files (order matters)")
    .option("--to-json <file>", "JSON schema file")
    .option("--to-empty", "empty schema")
    .option("--to-database <url>", "database connection URL (read-only)")
    .option("--to-migrations-dir <path>", "migrations directory");
}

function fromOpts(opts: Record<string, unknown>): SchemaSourceOpts {
  return {
    sql: opts.fromSql as string[] | undefined,
    json: opts.fromJson as string | undefined,
    empty: opts.fromEmpty as boolean | undefined,
    database: opts.fromDatabase as string | undefined,
    migrationsDir: opts.fromMigrationsDir as string | undefined,
  };
}

function toOpts(opts: Record<string, unknown>): SchemaSourceOpts {
  return {
    sql: opts.toSql as string[] | undefined,
    json: opts.toJson as string | undefined,
    empty: opts.toEmpty as boolean | undefined,
    database: opts.toDatabase as string | undefined,
    migrationsDir: opts.toMigrationsDir as string | undefined,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

declare const __VERSION__: string;

const program = new Command();

program
  .name("pgmagmig")
  .description("PostgreSQL migration tool with integrated schema differ, powered by PGlite")
  .version(__VERSION__);

// --- extract ---

const extractCmd = program
  .command("extract")
  .description("Read SQL files, apply to PGlite, output JSON schema");
addFromOptions(extractCmd);
extractCmd.action(async (opts) => {
  const schema = await resolveSchema(fromOpts(opts), "from");
  process.stdout.write(JSON.stringify(schema, null, 2) + "\n");
});

// --- generate ---

const generateCmd = program
  .command("generate")
  .description("Generate DDL from a schema (alias for diff --from-empty)");
addToOptions(generateCmd);
generateCmd.action(async (opts) => {
  const to = await resolveSchema(toOpts(opts), "to");
  const ddl = generateDdl(to);
  process.stdout.write(ddl);
});

// --- diff ---

const diffCmd = program
  .command("diff")
  .description("Compare two schemas and output DDL to transform one into the other")
  .option("--skip-validation", "skip automatic diff validation")
  .option("--annotated", "include -- HAZARD comments in output")
  .option("--check-hazards", "exit non-zero if any hazards are produced")
  .option("--allow-hazards <types>", "comma-separated hazard types to allow (or 'all')");
addFromOptions(diffCmd);
addToOptions(diffCmd);
diffCmd.action(async (opts) => {
  const from = await resolveSchema(fromOpts(opts), "from");
  const to = await resolveSchema(toOpts(opts), "to");

  const stmts = diffSchemaStatements(from, to);

  // Hazard gating
  if (opts.checkHazards) {
    const allowed = parseAllowedHazards(opts.allowHazards);
    const violations = stmts.flatMap((s) =>
      s.hazards.filter((h) => !allowed.has(h.type) && !allowed.has("all")),
    );
    if (violations.length > 0) {
      for (const v of violations) {
        console.error(`HAZARD (${v.type}): ${v.message}`);
      }
      process.exit(1);
    }
  }

  // Validation
  if (!opts.skipValidation && stmts.length > 0) {
    const ddl = stmts.map((s) => s.ddl).join(";\n") + ";\n";
    const errors = await validateDiff(from, to, ddl);
    if (errors.length > 0) {
      console.error("Diff validation failed:");
      for (const e of errors) {
        console.error(`  ${e.message}`);
      }
      process.exit(1);
    }
  }

  // Output
  if (opts.annotated) {
    process.stdout.write(diffSchemaAnnotated(from, to));
  } else {
    process.stdout.write(diffSchema(from, to));
  }
});

// --- bootstrap ---

const bootstrapCmd = program
  .command("bootstrap")
  .description("Write 0001.yaml (and optionally 0002.yaml for existing schemas)")
  .requiredOption("--migrations-dir <path>", "migrations directory")
  .option("--management-table <name>", "management table name", "public.schema_migrations");
addFromOptions(bootstrapCmd);
bootstrapCmd.action(async (opts) => {
    const tableName = opts.managementTable;
    const createTableSql = `CREATE TABLE ${tableName} (\n  sequence integer PRIMARY KEY,\n  uuid uuid NOT NULL,\n  title text NOT NULL,\n  down text\n);`;
    const dropTableSql = `DROP TABLE ${tableName};`;

    const { randomUUID } = await import("node:crypto");
    const { writeFile: writeFileFs } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { formatMigrationYaml } = await import("./migration.js");
    const { mkdir } = await import("node:fs/promises");

    await mkdir(opts.migrationsDir, { recursive: true });

    const uuid1 = randomUUID();
    const fOpts = fromOpts(opts);
    const hasExistingSchema = fOpts.sql || fOpts.json || fOpts.database || fOpts.migrationsDir;
    const title1 = hasExistingSchema
      ? "Create pgmagmig management table"
      : `Create pgmagmig management table ${tableName}`;

    if (!hasExistingSchema) {
      // Fresh start — just 0001.yaml
      const comment = [
        `# pgmagmig bootstrap migration`,
        `#`,
        `# This migration creates the pgmagmig management table.`,
        `# To apply it to a fresh database:`,
        `#`,
        `#   pgmagmig migrate --migrations-dir ${opts.migrationsDir} \\`,
        `#     --database-url postgres://... \\`,
        `#     --allow-missing-management-table`,
        `#`,
      ].join("\n") + "\n";

      const yaml = formatMigrationYaml({
        title: title1, uuid: uuid1, up: createTableSql, down: dropTableSql,
      });
      await writeFileFs(join(opts.migrationsDir, "0001.yaml"), comment + yaml, "utf-8");
      console.log("Created 0001.yaml");
    } else {
      // Existing database — 0001.yaml + 0002.yaml
      const existingSchema = await resolveSchema(fOpts, "from");
      const { escapeLiteral: esc } = await import("./escape.js");

      // Diff from empty to the existing schema
      const upDdl = diffSchemaAnnotated(emptySchema(), existingSchema);
      const downDdl = diffSchema(existingSchema, emptySchema());

      const uuid2 = randomUUID();
      const title2 = "Existing database schema";

      const insertSql = `INSERT INTO ${tableName} (sequence, uuid, title, down) VALUES\n` +
        `    (1, ${esc(uuid1)}, ${esc(title1)}, NULL),\n` +
        `    (2, ${esc(uuid2)}, ${esc(title2)}, NULL);`;

      const comment = [
        `# pgmagmig bootstrap migration`,
        `#`,
        `# This migration creates the pgmagmig management table.`,
        `# A second migration (0002.yaml) captures the existing schema.`,
        `#`,
        `# To transition an existing database to pgmagmig, run the`,
        `# following SQL using your current migration system or manually:`,
        `#`,
        `#   ${createTableSql.replace(/\n/g, "\n#   ")}`,
        `#`,
        `#   ${insertSql.replace(/\n/g, "\n#   ")}`,
        `#`,
        `# After running this SQL, your database has the pgmagmig`,
        `# management table with both migrations recorded. The schema`,
        `# is in sync. You can now use pgmagmig for all future migrations.`,
        `#`,
        `# If your previous system had its own management table, create`,
        `# a pgmagmig migration to drop it.`,
        `#`,
      ].join("\n") + "\n";

      const yaml1 = formatMigrationYaml({
        title: title1, uuid: uuid1, up: createTableSql, down: null,
      });
      await writeFileFs(join(opts.migrationsDir, "0001.yaml"), comment + yaml1, "utf-8");
      console.log("Created 0001.yaml");

      const yaml2 = formatMigrationYaml({
        title: title2, uuid: uuid2,
        up: upDdl || "-- no changes",
        down: null,
      });
      await writeFileFs(join(opts.migrationsDir, "0002.yaml"), yaml2, "utf-8");
      console.log("Created 0002.yaml");
    }
  });

// --- draft-migration ---

const draftCmd = program
  .command("draft-migration")
  .description("Generate a YAML migration file from a schema diff")
  .requiredOption("--migrations-dir <path>", "migrations directory")
  .requiredOption("--title <title>", "migration title")
  .option("--no-invalid", "omit the invalid: true marker")
  .option("--skip-validation", "skip up/down roundtrip validation")
  .option("--allow-hazards <types>", "comma-separated hazard types to allow (or 'all')");
addToOptions(draftCmd);
draftCmd.action(async (opts) => {
  // Build "from" schema by applying existing migrations
  const fromSchema = await resolveSchema(
    { migrationsDir: opts.migrationsDir },
    "from",
  );
  const toSchema = await resolveSchema(toOpts(opts), "to");

  const upStmts = diffSchemaStatements(fromSchema, toSchema);
  const downStmts = diffSchemaStatements(toSchema, fromSchema);

  // Hazard gating
  const allowed = parseAllowedHazards(opts.allowHazards);
  const allHazards = [...upStmts, ...downStmts].flatMap((s) => s.hazards);
  const violations = allHazards.filter(
    (h) => !allowed.has(h.type) && !allowed.has("all"),
  );
  if (violations.length > 0) {
    console.error("Hazards detected (use --allow-hazards to proceed):");
    for (const v of violations) {
      console.error(`  HAZARD (${v.type}): ${v.message}`);
    }
    process.exit(1);
  }

  const upDdl = diffSchemaAnnotated(fromSchema, toSchema);
  const downDdl = diffSchema(toSchema, fromSchema);

  // Validation
  if (!opts.skipValidation) {
    if (upDdl) {
      const upErrors = await validateDiff(fromSchema, toSchema, upDdl);
      if (upErrors.length > 0) {
        console.error("Up migration validation failed:");
        for (const e of upErrors) console.error(`  ${e.message}`);
        process.exit(1);
      }
    }
    if (downDdl) {
      const downErrors = await validateDiff(toSchema, fromSchema, downDdl);
      if (downErrors.length > 0) {
        console.error("Down migration validation failed:");
        for (const e of downErrors) console.error(`  ${e.message}`);
        process.exit(1);
      }
    }
  }

  const filename = await writeMigrationFile(opts.migrationsDir, {
    title: opts.title,
    up: upDdl || "-- no changes",
    down: downDdl || "",
    invalid: opts.invalid !== false,
  });

  console.log(`Created ${filename}`);
});

// --- migrate ---

program
  .command("migrate")
  .description("Apply outstanding migrations to a PostgreSQL database")
  .requiredOption("--migrations-dir <path>", "migrations directory")
  .option("--management-table <name>", "management table name", "public.schema_migrations")
  .option("--database-url <url>", "database connection URL")
  .option("--allow-missing-management-table", "treat missing management table as zero applied")
  .option("--allow-rollback", "allow down-migrations (often destructive)")
  .option("--dry-run", "print plan without executing")
  .option("--check", "exit non-zero if any migrations are pending")
  .action(async (opts) => {
    const dbUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error("No database URL. Use --database-url or set DATABASE_URL.");
    }

    const files = await readMigrationDirectory(opts.migrationsDir);
    const client = new pg.Client({ connectionString: dbUrl });
    await client.connect();

    try {
      const result = await migrate({
        db: client,
        files,
        managementTable: opts.managementTable,
        allowMissingManagementTable: opts.allowMissingManagementTable,
        allowRollback: opts.allowRollback,
        dryRun: opts.dryRun,
        check: opts.check,
      });

      if (opts.check && result.pending) {
        process.exit(1);
      }
    } finally {
      await client.end();
    }
  });

// --- run ---

const runCmd = program
  .command("run")
  .description("Build a PGlite database, expose via Unix socket (or TCP with --host), and run a command with DATABASE_URL")
  .requiredOption("--command <cmd>", "shell command to run")
  .option("--host <host>", "bind address (enables TCP instead of Unix socket)")
  .option("--port <port>", "bind port for TCP (0 = ephemeral)", "0");
addFromOptions(runCmd);
runCmd.action(async (opts) => {
  const sqlStatements = await resolveToSql(fromOpts(opts), "from");
  const exitCode = await runWithEphemeralDb({
    sqlStatements,
    command: opts.command,
    host: opts.host,
    port: opts.host ? parseInt(opts.port, 10) : undefined,
  });
  process.exit(exitCode);
});

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

function parseAllowedHazards(value?: string): Set<string> {
  if (!value) return new Set();
  return new Set(value.split(",").map((s) => s.trim()));
}

function formatError(err: unknown): never {
  if (err instanceof MigrationError) {
    process.exit(1);
  }
  if (err instanceof Error) {
    const pgErr = err as {
      severity?: string;
      code?: string;
      detail?: string;
      hint?: string;
      where?: string;
      message: string;
    };

    if (pgErr.code) {
      console.error(`ERROR: ${pgErr.message}`);
      console.error(`Code: ${pgErr.code}`);
      if (pgErr.detail) console.error(`Detail: ${pgErr.detail}`);
      if (pgErr.hint) console.error(`Hint: ${pgErr.hint}`);
      if (pgErr.where) console.error(`Where: ${pgErr.where}`);
    } else {
      console.error(`ERROR: ${pgErr.message}`);
    }
  } else {
    console.error(`ERROR: ${err}`);
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

program.parseAsync().catch(formatError);
