# bootstrap

Create the initial migration file(s) for a new pgmagmig-managed project.

## Usage

```bash
# Fresh database
pgmagmig bootstrap --migrations-dir ./migrations

# Existing database
pgmagmig bootstrap --migrations-dir ./migrations --from-database postgres://localhost/mydb
pgmagmig bootstrap --migrations-dir ./migrations --from-sql schema.sql
```

## Options

| Option | Description |
|--------|-------------|
| `--migrations-dir <path>` | **(required)** Directory to write migration files |
| `--management-table <name>` | Management table name (default: `public.schema_migrations`) |
| `--from-sql <files...>` | Existing schema as SQL files |
| `--from-json <file>` | Existing schema as JSON |
| `--from-database <url>` | Existing schema from live database (read-only) |
| `--from-migrations-dir <path>` | Existing schema from another migrations directory |
| `--quick` | Use the faster static differ instead of the reconciliation loop when capturing an existing schema |

## Behaviour

### Without `--from-*` (fresh database)

Creates a single file:

- **`0001.yaml`** — DDL to create the management table, with a down migration (`DROP TABLE`).

The file includes a comment explaining how to apply it:

```bash
pgmagmig migrate --migrations-dir ./migrations \
  --database-url postgres://... \
  --allow-missing-management-table
```

### With `--from-*` (existing database)

Creates two files:

- **`0001.yaml`** — DDL to create the management table, with no down migration.
- **`0002.yaml`** — DDL to create the existing schema (everything except the management table), with no down migration.

The comment in `0001.yaml` provides copy-pasteable SQL to register both migrations in an existing database:

```sql
CREATE TABLE public.schema_migrations (
  sequence integer PRIMARY KEY,
  uuid uuid NOT NULL,
  title text NOT NULL,
  down text
);

INSERT INTO public.schema_migrations (sequence, uuid, title, down) VALUES
    (1, '<uuid>', 'Create pgmagmig management table', NULL),
    (2, '<uuid>', 'Existing database schema', NULL);
```

Run this SQL using your current migration system or manually. After that, the database has the pgmagmig management table with both migrations recorded, and the schema is in sync.

See [Getting Started: Existing Database](../getting-started/existing.md) for a complete walkthrough.
