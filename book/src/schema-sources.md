# Schema Sources

Most pgmagmig commands accept `--from-*` and/or `--to-*` options to specify where to read a schema from. Exactly one source must be given per side.

## Available sources

### `--from-sql <files...>` / `--to-sql <files...>`

Read one or more SQL files and apply them in order to a PGlite instance. The resulting schema is extracted from PGlite's system catalogs.

Order matters — if `02-tables.sql` references a type defined in `01-types.sql`, list them in that order.

```bash
pgmagmig diff --from-sql 01-types.sql 02-tables.sql --to-sql new-schema.sql
```

### `--from-json <file>` / `--to-json <file>`

Read a JSON schema file, as produced by `pgmagmig extract`.

```bash
pgmagmig extract --from-sql schema.sql > schema.json
pgmagmig diff --from-json old.json --to-json new.json
```

### `--from-empty` / `--to-empty`

An empty schema containing only the `public` schema (which PostgreSQL always has).

```bash
# Generate DDL for a complete schema (from nothing to everything)
pgmagmig diff --from-empty --to-sql schema.sql
```

### `--from-database <url>` / `--to-database <url>`

Connect to a live PostgreSQL database and extract its schema. The connection uses `BEGIN READ ONLY` followed by `ROLLBACK` — nothing is written.

```bash
pgmagmig diff --from-database postgres://localhost/prod --to-sql schema.sql
```

### `--from-migrations-dir <path>` / `--to-migrations-dir <path>`

Read all YAML migration files from the directory, apply their `up` SQL in order to a PGlite instance, and extract the resulting schema.

All migration files must be valid — any file with `invalid: true` causes an immediate error.

```bash
pgmagmig diff --from-migrations-dir ./migrations --to-sql schema.sql
```
