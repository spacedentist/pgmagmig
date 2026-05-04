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
| `--skip-validation` | Skip automatic diff validation via PGlite |
| `--annotated` | Include `-- HAZARD (type): message` comments |
| `--check-hazards` | Exit non-zero if any hazards are produced |
| `--allow-hazards <types>` | Comma-separated hazard types to allow (or `all`) |

## Output

DDL statements written to stdout. With `--annotated`, hazard comments appear above their statements.

## Validation

By default, every diff is validated by applying it to a PGlite instance populated with the "from" schema and comparing the result to the "to" schema. Use `--skip-validation` to disable this (faster, but no correctness guarantee).

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
