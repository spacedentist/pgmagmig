# verify-down

Verify that down-migrations correctly reverse their up-migrations.

Migrations drafted by pgmagmig have correct down SQL by construction, but you often edit them by hand — to restore data, or after tweaking the schema and the up SQL. This command checks that a down still returns the schema to exactly the state it was in before the migration ran.

## Usage

```bash
# Check the most recent migration's down (the default)
pgmagmig verify-down --migrations-dir ./migrations

# Check the last 3 migrations
pgmagmig verify-down --migrations-dir ./migrations --last 3

# Check the entire chain
pgmagmig verify-down --migrations-dir ./migrations --all
```

## Options

| Option | Description |
|--------|-------------|
| `--migrations-dir <path>` | **(required)** Migrations directory |
| `--last <n>` | Number of trailing migrations to check (default: `1`) |
| `--all` | Check every migration in the chain |

## How it works

Against a throwaway [PGlite](https://pglite.dev) instance, each checked migration runs an **up → down → up "dance"**, comparing schema snapshots at each step:

1. Snapshot the schema **before** the migration (S₀).
2. Apply `up`, snapshot (S₁).
3. Apply `down`, snapshot — assert it matches **S₀** (the down restored the prior schema).
4. Apply `up` again, snapshot — assert it matches **S₁** (the up is reproducible).

Only a trailing window is danced. To check the last *N*, the earlier migrations' ups are applied plainly to build the base state, then the dance runs on the final *N*. The default window is the single most recent migration; use `--last` or `--all` to widen it.

Each migration is applied as a single transaction, mirroring how [`migrate`](./migrate.md) runs them — so a down that only works outside a transaction, or one that forgets a needed `SET`, is caught.

## What is compared

Snapshots are compared **structurally** (tables, columns, constraints, indexes, views, functions, triggers, enums, sequences), the same model the differ uses. Data is not compared — a down that restores dropped data still passes as long as the schema matches, which is the intended granularity.

## Skipped migrations

A migration is skipped (not a failure) when it has nothing to reverse:

- **No down** (`down` omitted / null) — there is no down migration to check.
- **No-op down** (bare `down:`, an empty string) — the down is an intentional no-op, so it is not expected to restore the schema.

## Work-in-progress migrations

Freshly drafted migrations carry `invalid: true`, and `verify-down` is exactly the tool you use while reviewing them. Unlike other commands, it does **not** treat `invalid: true` as a hard stop — it prints a warning and checks the migration anyway.

## Exit status

Exits `0` if every checked migration passes (or is skipped), and `1` if any down fails to restore the schema or errors while executing. Suitable as a CI check.

## Example output

```text
warning: 0007.yaml is marked invalid: true (checking anyway)
  ok        0005 add orders table
  ok        0006 add orders index
  MISMATCH  0007 add status column
            down migration does not restore the pre-migration schema:
              - unexpected column status

pgmagmig: 1 migration failed verification
```
