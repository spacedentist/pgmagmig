# pgmagmig

A PostgreSQL migration tool with an integrated schema differ, powered by [PGlite](https://pglite.dev) (PostgreSQL compiled to WASM).

Schema extraction, DDL generation, diffing, and diff validation all run **in-process** against PGlite. No external PostgreSQL server is required for these operations. A real PostgreSQL server is only needed when applying migrations.

## Features

- **Schema extraction**: apply SQL to an in-memory PGlite instance, query its system catalogs, produce a JSON representation of the schema.
- **DDL generation**: turn a JSON schema back into SQL DDL.
- **Schema diffing**: compare two schemas, produce DDL that transforms one into the other. Generates readable `CREATE TABLE` statements with defaults, constraints, and foreign keys inlined where possible.
- **Automatic diff validation**: every diff is verified by applying it to PGlite and comparing the resulting schema to the expected one.
- **Hazard annotations**: destructive or lock-heavy statements are tagged with a structured hazard type and human-readable message.
- **Migration drafting**: generate a YAML migration file from a schema diff, with up and down SQL and hazard annotations.
- **Migration runner**: sequential numbering, up/down, branch switching, per-migration transactions.
- **Ephemeral database**: build a PGlite database from any schema source, expose it via Unix socket or TCP, and run a shell command (with `DATABASE_URL` set in the environment). Works with Prisma, sqlc, pgtyped, psql, or anything that speaks PostgreSQL.

## Install

```bash
npm install pgmagmig
```

Requires Node.js 20 or later.

## Quick start

### Bootstrap a migration directory

```bash
pgmagmig bootstrap --migrations-dir ./migrations
```

Creates `0001.yaml` with DDL to set up the management table. The generated YAML file includes a comment with more information on how to switch to pgmagmig for an existing database, or how to start fresh using this migration.

### Draft a migration

```bash
pgmagmig draft-migration \
  --migrations-dir ./migrations \
  --to-sql schema.sql \
  --title "Add users and orders" \
  --allow-hazards all
```

Generates a YAML migration file with up/down SQL, validated by roundtripping through PGlite.

### Apply migrations

```bash
pgmagmig migrate \
  --migrations-dir ./migrations \
  --database-url postgres://localhost/mydb
```

### Diff two schemas

```bash
pgmagmig diff --from-sql old.sql --to-sql new.sql
```

### Run a command against an ephemeral PGlite

```bash
pgmagmig run \
  --from-migrations-dir ./migrations \
  --command "npx prisma db pull"
```

Builds a PGlite database from your migrations, exposes it via Unix socket, and runs the given command with `DATABASE_URL` set to the connection string needed to use this ephemeral database.

## CLI commands

| Command | Description |
|---------|-------------|
| `extract` | Apply SQL to PGlite, output JSON schema |
| `generate` | Generate DDL from a schema (alias for `diff --from-empty`) |
| `diff` | Compare two schemas, output DDL |
| `bootstrap` | Write `0001.yaml` with management table DDL |
| `draft-migration` | Generate a YAML migration file from a schema diff |
| `verify-down` | Check that down-migrations reverse their up-migrations |
| `migrate` | Apply migrations to a PostgreSQL database |
| `run` | Build PGlite, expose via socket, run a command |

### Schema sources

All commands that read schemas accept `--from-*` and/or `--to-*` options:

- `--from-sql file1.sql file2.sql`: SQL files (order matters)
- `--from-json schema.json`: pgmagmig JSON schema file
- `--from-empty`: empty schema
- `--from-database postgres://...`: live database (read-only)
- `--from-migrations-dir ./migrations`: pgmagmig migrations directory (all up-migrations will be applied in order)

## Migration files

Migrations are YAML files named `0001.yaml`, `0002.yaml`, etc. Sequential numbering is enforced: gaps are errors.

```yaml
title: Create users table
uuid: 7f3b2a1e-8c4d-4e5f-9a6b-1c2d3e4f5a6b
up: |
  CREATE TABLE public.users (
    id SERIAL NOT NULL,
    email text NOT NULL,
    CONSTRAINT users_pkey PRIMARY KEY (id),
    CONSTRAINT users_email_key UNIQUE (email)
  );
down: |
  DROP TABLE public.users;
```

The `down` field has three states:
- **SQL string**: rollback runs this SQL
- **Empty string**: rollback is a no-op (row still removed from management table)
- **Omitted**: rollback errors if attempted

## Hazards

The differ tags statements with structured hazard types:

| Hazard type | Meaning |
|-------------|---------|
| `DeletesData` | Destroys user data (DROP TABLE, DROP COLUMN) |
| `AcquiresAccessExclusiveLock` | Blocks all reads and writes |
| `RequiresPopulatedTableScan` | Scans entire table (SET NOT NULL) |
| `IndexDropped` | May degrade query performance |
| `IndexBuild` | Long-running index build |
| `Correctness` | May break application behaviour |
| `HasUntrackableDependencies` | Drops an object others may depend on |

Use `--allow-hazards` to acknowledge specific types, or `--check-hazards` in CI to block on unexpected hazards.

## License

[ISC](LICENSE)
