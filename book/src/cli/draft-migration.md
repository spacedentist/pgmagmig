# draft-migration

Generate a YAML migration file by diffing the current migrations against a target schema.

## Usage

```bash
pgmagmig draft-migration \
  --migrations-dir ./migrations \
  --to-sql schema.sql \
  --title "Add orders table" \
  --allow-hazards all
```

## Options

| Option | Description |
|--------|-------------|
| `--migrations-dir <path>` | **(required)** Migrations directory (used as the "from" schema) |
| `--title <title>` | **(required)** Human-readable migration title |
| `--to-sql <files...>` | Target schema as SQL files |
| `--to-json <file>` | Target schema as JSON |
| `--to-empty` | Target is empty (generates a "drop everything" migration) |
| `--to-database <url>` | Target schema from live database (read-only) |
| `--to-migrations-dir <path>` | Target from another migrations directory |
| `--no-invalid` | Don't add the `invalid: true` marker |
| `--quick` | Use the faster static differ instead of the reconciliation loop |
| `--skip-validation` | Skip up/down roundtrip validation (static differ only) |
| `--allow-hazards <types>` | Comma-separated hazard types to allow (or `all`) |

Exactly one `--to-*` option is required.

## How it works

1. Builds the "from" schema by applying all existing migrations in `--migrations-dir` to PGlite.
2. Builds the "to" schema from the `--to-*` source.
3. Plans in both directions: `from → to` for the up SQL, `to → from` for the down SQL.
4. Writes the next sequential YAML file (e.g., `0003.yaml`).

By default the plan comes from the reconciliation loop, whose output is correct by construction (see [`diff`](./diff.md) for how it works). `--quick` selects the one-shot static differ instead and validates both directions by roundtripping through PGlite; `--skip-validation` disables that check.

## The invalid marker

By default, generated migrations include `invalid: true`. This prevents them from being applied (by `migrate` or read by any command that processes the migrations directory) until you've reviewed the SQL and removed the marker. Use `--no-invalid` to skip this.

## Hazard gating

The command fails if the generated diff contains any hazard types not listed in `--allow-hazards`. Use `--allow-hazards all` during development, and more restrictive allow-lists in CI.

## Output

The generated YAML file includes `-- HAZARD (type): message` comments in the up SQL, so hazards are visible during code review.
