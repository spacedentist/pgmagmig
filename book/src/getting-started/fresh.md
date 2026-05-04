# Fresh Database

If you're starting a new project with an empty database, getting started with pgmagmig takes three steps.

## 1. Bootstrap the migrations directory

```bash
pgmagmig bootstrap --migrations-dir ./migrations
```

This creates `0001.yaml` containing DDL to set up pgmagmig's management table. The management table tracks which migrations have been applied.

## 2. Define your schema and draft a migration

Write your desired schema as SQL:

```sql
-- schema.sql
CREATE TABLE public.schema_migrations (
  sequence integer PRIMARY KEY,
  uuid uuid NOT NULL,
  title text NOT NULL,
  down text
);

CREATE TABLE public.users (
  id SERIAL PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text,
  created_at timestamptz DEFAULT now()
);
```

Note that the management table must be included in your schema definition — it's part of the managed schema, not hidden.

Then draft a migration:

```bash
pgmagmig draft-migration \
  --migrations-dir ./migrations \
  --to-sql schema.sql \
  --title "Create users table" \
  --allow-hazards all
```

This creates `0002.yaml` with the DDL to transform the database from the state after `0001.yaml` (just the management table) to your desired schema. The migration is automatically validated by applying both the up and down SQL to PGlite and verifying the result.

Review the generated file. By default it includes `invalid: true`, which prevents it from being applied until you've reviewed the SQL and removed that marker. Use `--no-invalid` to skip this if you trust the output.

## 3. Apply migrations

```bash
pgmagmig migrate \
  --migrations-dir ./migrations \
  --database-url postgres://localhost/mydb \
  --allow-missing-management-table
```

The `--allow-missing-management-table` flag is needed for the very first run, since the management table doesn't exist yet — it's created by `0001.yaml`.

After this, the database has the management table and your schema. Future migrations don't need the flag.

## Next steps

From here, the workflow is:

1. Edit your schema SQL file (or work directly with migration files).
2. Run `pgmagmig draft-migration` to generate the next migration.
3. Review and apply with `pgmagmig migrate`.

See [Developer Workflow](../workflow.md) for day-to-day usage patterns.
