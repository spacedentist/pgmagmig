# migrate

Apply outstanding migrations to a PostgreSQL database.

## Usage

```bash
pgmagmig migrate \
  --migrations-dir ./migrations \
  --database-url postgres://localhost/mydb

# First run (management table doesn't exist yet)
pgmagmig migrate \
  --migrations-dir ./migrations \
  --database-url postgres://localhost/mydb \
  --allow-missing-management-table

# Branch switching (requires rollback)
pgmagmig migrate \
  --migrations-dir ./migrations \
  --database-url postgres://localhost/mydb \
  --allow-rollback
```

## Options

| Option | Description |
|--------|-------------|
| `--migrations-dir <path>` | **(required)** Migrations directory |
| `--management-table <name>` | Management table name (default: `public.schema_migrations`) |
| `--database-url <url>` | Database connection URL (or `DATABASE_URL` env var) |
| `--allow-missing-management-table` | Treat a missing management table as zero applied |
| `--allow-rollback` | Allow down-migrations (required for branch switching) |
| `--dry-run` | Print the plan without executing |
| `--check` | Exit non-zero if any migrations are pending |

## How it works

1. Reads all migration files from the directory.
2. Reads all applied migrations from the management table.
3. Finds the longest prefix where the file UUIDs match the applied UUIDs.
4. Everything beyond the match point in the database is rolled back (in reverse order).
5. Everything beyond the match point in the files is applied (in order).

Each migration (up or down) runs in its own transaction. If a migration fails, the transaction is rolled back and the management table remains consistent.

## The plan is always printed

Before executing, `migrate` prints what it will do:

```
Rollback required (1 migration)
  rollback: 0003 — Add notifications
Migrations to apply (2 migrations)
  apply: 0003 — Add orders table
  apply: 0004 — Add order items
```

This happens even with `--dry-run`, `--check`, and when rollback is blocked (no `--allow-rollback`).

## Rollback safety

Down-migrations are often destructive — they drop tables, columns, or data. By default, `migrate` refuses to run them:

```
ERROR: 1 migration(s) need to be rolled back. Down-migrations are often
destructive. Use --allow-rollback to proceed.
```

Use `--allow-rollback` to opt in. This is typically used during development when switching between feature branches.

## CI usage

```bash
# Fail if the database is not in sync with migrations
pgmagmig migrate \
  --migrations-dir ./migrations \
  --database-url $DATABASE_URL \
  --check
```

The `--check` flag prints the plan and exits with status 1 if anything is pending, without modifying the database.
