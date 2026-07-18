# diff

Compare two schemas and output the DDL to transform one into the other.

## Usage

```bash
pgmagmig diff --from-sql old.sql --to-sql new.sql
pgmagmig diff --from-migrations-dir ./migrations --to-database postgres://localhost/mydb
pgmagmig diff --from-empty --to-sql schema.sql
```

## Options

### Schema sources

| Option | Description |
|--------|-------------|
| `--from-sql <files...>` | SQL files for the source schema |
| `--from-json <file>` | JSON schema file for the source |
| `--from-empty` | Empty source schema |
| `--from-database <url>` | Live database as source (read-only) |
| `--from-migrations-dir <path>` | Build source from migration files |
| `--to-sql <files...>` | SQL files for the target schema |
| `--to-json <file>` | JSON schema file for the target |
| `--to-empty` | Empty target schema |
| `--to-database <url>` | Live database as target (read-only) |
| `--to-migrations-dir <path>` | Build target from migration files |

Exactly one `--from-*` and one `--to-*` option is required.

### Behaviour options

| Option | Description |
|--------|-------------|
| `--quick` | Use the faster static differ instead of the reconciliation loop (see below) |
| `--skip-validation` | Skip automatic diff validation via PGlite (static differ only) |
| `--annotated` | Include `-- HAZARD (type): message` comments |
| `--check-hazards` | Exit non-zero if any hazards are produced |
| `--allow-hazards <types>` | Comma-separated hazard types to allow (or `all`) |

## Output

DDL statements written to stdout. With `--annotated`, hazard comments appear above their statements.

## How the DDL is planned

By default, `diff` uses the **reconciliation loop**: it applies changes to an in-memory PGlite instance step by step, re-reading the schema after each step until it matches the target. Because it plans against a live database, it copes with awkward interdependencies — reordering interdependent views and functions, and dropping-and-recreating dependent objects when the thing they depend on changes. Its output is correct by construction, so no separate validation step is needed.

`--quick` selects the one-shot **static differ** instead. It computes the whole plan in a single pass, which is faster and produces a minimal diff, but in some situations may mis-order complex inter-object dependencies. In practice it handles most schemas well (it uses the same fine-grained ordering buckets as the reconciliation loop). When `--quick` is used, the plan is validated by applying it to a fresh PGlite instance and comparing the result to the target; `--skip-validation` disables that check (faster, but no correctness guarantee).

## Hazard gating

When `--check-hazards` is set, `diff` exits with status 1 if any statement carries a hazard type not listed in `--allow-hazards`. This is useful in CI as a tripwire against unexpectedly destructive drift.

```bash
# Fail if the diff contains any hazard except IndexBuild
pgmagmig diff \
  --from-migrations-dir ./migrations \
  --to-sql schema.sql \
  --check-hazards \
  --allow-hazards IndexBuild
```
