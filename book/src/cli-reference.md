# CLI Reference

pgmagmig provides the following commands:

| Command | Description |
|---------|-------------|
| [`extract`](./cli/extract.md) | Apply SQL to PGlite, output JSON schema |
| [`generate`](./cli/generate.md) | Generate DDL from a schema |
| [`diff`](./cli/diff.md) | Compare two schemas, output DDL |
| [`bootstrap`](./cli/bootstrap.md) | Create initial migration file(s) |
| [`draft-migration`](./cli/draft-migration.md) | Generate a YAML migration from a schema diff |
| [`migrate`](./cli/migrate.md) | Apply migrations to a PostgreSQL database |
| [`run`](./cli/run.md) | Build PGlite, expose via socket, run a command |

## Common patterns

Most commands accept [schema source](./schema-sources.md) options (`--from-*` and/or `--to-*`) to specify where to read schemas from.

## Error output

pgmagmig formats PostgreSQL errors cleanly, showing the error code, message, detail, and hint without stack traces:

```
ERROR: relation "foo" does not exist
Code: 42P01
```
