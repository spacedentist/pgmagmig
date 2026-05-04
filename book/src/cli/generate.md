# generate

Generate DDL from a schema. This is an alias for `diff --from-empty --to-*`.

## Usage

```bash
pgmagmig generate --to-sql schema.sql
pgmagmig generate --to-json schema.json
```

## Options

| Option | Description |
|--------|-------------|
| `--to-sql <files...>` | SQL files defining the target schema |
| `--to-json <file>` | JSON schema file |
| `--to-empty` | Empty schema (produces no output) |
| `--to-database <url>` | Live database |
| `--to-migrations-dir <path>` | Migration files |

Exactly one `--to-*` option is required. See [Schema Sources](../schema-sources.md).

## Output

DDL statements written to stdout that would create the entire schema from scratch.

## Example

```bash
pgmagmig generate --to-json schema.json > create.sql
```
