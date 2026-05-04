# Migration Files

Migrations are YAML files stored in a directory. They are named sequentially: `0001.yaml`, `0002.yaml`, `0003.yaml`, and so on.

## Format

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

## Fields

| Field | Required | Description |
|-------|----------|-------------|
| `title` | yes | Human-readable description of the migration |
| `uuid` | yes | Unique identifier (UUID v4). Defines the migration's identity for matching against the management table. |
| `up` | yes | SQL statements to apply the migration |
| `down` | no | SQL statements to reverse the migration (see below) |
| `invalid` | no | If `true`, all commands refuse to process this file |

## The `down` field: three states

The `down` field has three distinct states with different runtime behaviour:

- **Present with SQL** (`down: "DROP TABLE users;"`) — the runner executes this SQL when rolling back.
- **Present but empty** (`down: ""` or `down:`) — rollback is a no-op. The row is removed from the management table, but no SQL is executed. Use this when a migration can't be meaningfully reversed but you want to allow the runner to proceed past it.
- **Omitted** (no `down` key at all) — the runner errors if rollback is attempted. Use this for migrations that are truly irreversible, like dropping a table with data that can't be recreated.

In the management table, these map to: a SQL string, an empty string, and `NULL`, respectively.

## The `invalid` marker

When `draft-migration` generates a file, it includes `invalid: true` by default. This is a safety net: the generated SQL should be reviewed by a human before it's applied. Any command that reads migration files (including `migrate`, `diff --from-migrations-dir`, and `run --from-migrations-dir`) errors immediately if it encounters an invalid file.

After reviewing the SQL, remove the `invalid: true` line (or the entire `invalid` field).

Use `--no-invalid` on `draft-migration` to skip the marker if you trust the output.

## Sequential numbering

Files must be numbered consecutively starting at 1. Any gap is an error: if `0001.yaml` and `0003.yaml` exist but `0002.yaml` doesn't, all commands refuse to proceed.

This is deliberate — see [Migration Philosophy](./philosophy.md) for the rationale.

## UUID identity

The UUID field, not the filename, defines a migration's identity. When the runner compares migration files to the management table, it matches by UUID at each sequence position. If the UUID at position 3 in the files doesn't match the UUID at position 3 in the database, everything from position 3 onward is rolled back and reapplied.

This enables branch switching: when you check out a different branch with different migrations, the UUIDs diverge and the runner handles the transition automatically.
