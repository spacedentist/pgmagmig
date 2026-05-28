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

## Migration plan

Before executing, `migrate` prints a plan to stderr showing what it will do:

```
pgmagmig: migration plan

  rollback 0003 Add notifications
  apply    0003 Add orders table
  apply    0004 Add order items

1 migration to roll back, 2 migrations to apply
```

This happens even with `--dry-run`, `--check`, and when rollback is blocked (no `--allow-rollback`). When the database is already up to date, no plan is printed — just the summary.

## Execution output

During execution, every SQL statement is printed before it runs. This includes transaction control (`BEGIN`, `COMMIT`) and management table writes, giving full visibility into what happens on the database. After each statement, the execution time is shown:

```
-- 0003 Add orders table

  [1/5] BEGIN
        ok (1ms)
  [2/5] CREATE TABLE public.orders (
          id integer NOT NULL,
          user_id integer NOT NULL
        )
        ok (4ms)
  [3/5] ALTER TABLE public.orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id)
        ok (2ms)
  [4/5] INSERT INTO public.schema_migrations (sequence, uuid, title, down) VALUES (...)
        ok (1ms)
  [5/5] COMMIT
        ok (0ms)

-- 0003 done (38ms)
```

The `[N/M]` counter shows which statement is running. Multi-line SQL is displayed in full, with continuation lines indented to align with the first. The `done` line shows the wall-clock time for the entire migration.

When all migrations complete, a summary is printed to stdout:

```
pgmagmig: 2 applied
```

Or with rollbacks:

```
pgmagmig: 1 rolled back, 2 applied
```

## Error output

If a statement fails, the error is shown with the PostgreSQL error code and message:

```
  [2/5] CREATE TABLE public.orders (id integer REFERENCES nonexistent(id))
        FAILED

ERROR in 0003 "Add orders table", statement 2/5
  Code:    42P01
  Message: relation "nonexistent" does not exist
```

Detail, hint, and context are included when the database provides them. No further migrations are executed after an error.

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
