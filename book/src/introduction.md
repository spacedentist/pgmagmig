# pgmagmig

**pgmagmig** is a PostgreSQL migration tool with an integrated schema differ, powered by [PGlite](https://pglite.dev) (PostgreSQL compiled to WASM).

Schema extraction, DDL generation, diffing, and diff validation all run **in-process** against PGlite. No external PostgreSQL server is required for any of these operations. A real PostgreSQL server is only needed when actually applying migrations to a database.

## What pgmagmig does

- **Extracts** a database schema into a JSON representation by querying PostgreSQL system catalogs.
- **Generates DDL** from a schema, producing readable `CREATE TABLE` statements with defaults, constraints, and foreign keys inlined.
- **Diffs** two schemas and produces the DDL to transform one into the other, with structured hazard annotations on destructive or lock-heavy statements.
- **Validates** every generated diff by applying it to an in-process PGlite instance and comparing the result to the expected schema.
- **Drafts migration files** in YAML format, with up and down SQL, automatically validated in both directions.
- **Runs migrations** against a real PostgreSQL database, with per-migration transactions, branch switching, and rollback support.
- **Exposes an ephemeral PGlite** via Unix socket or TCP, so any tool that speaks PostgreSQL (Prisma, sqlc, pgtyped, psql) can work against your migration-defined schema without a running database server.

## Why PGlite?

PGlite is real PostgreSQL 17 compiled to WASM. It's not an approximation or a compatibility layer. The system catalogs, type system, DDL parsing, and expression evaluation are identical to a full PostgreSQL server. This means pgmagmig's schema extraction and diff validation are tested against the same engine your production database runs.

The practical benefit: you can extract, diff, and validate schemas on your laptop, in CI, or anywhere Node.js runs, without provisioning a PostgreSQL instance.
