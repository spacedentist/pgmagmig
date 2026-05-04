# extract

Apply SQL to a PGlite instance, extract the schema, and output it as JSON.

## Usage

```bash
pgmagmig extract --from-sql schema.sql
pgmagmig extract --from-database postgres://localhost/mydb
pgmagmig extract --from-migrations-dir ./migrations
```

## Options

| Option | Description |
|--------|-------------|
| `--from-sql <files...>` | SQL files to apply (order matters) |
| `--from-json <file>` | JSON schema file |
| `--from-empty` | Empty schema |
| `--from-database <url>` | Live database (read-only extraction) |
| `--from-migrations-dir <path>` | Apply migration files to PGlite |

Exactly one `--from-*` option is required. See [Schema Sources](../schema-sources.md).

## Output

JSON representation of the database schema, written to stdout. The output includes tables (with columns and constraints), indexes, views, functions, triggers, enums, sequences, schemas, and extensions.

## Example

```bash
pgmagmig extract --from-sql schema.sql > schema.json
```
