# Developer Workflow

pgmagmig is designed for the day-to-day reality of working on a codebase where multiple developers are making schema changes on different branches.

## The purpose of down migrations

A common misconception is that down migrations exist to roll back production deployments. They don't — or at least, they shouldn't. If you need to revert a schema change in production, write a *new* forward migration that undoes the change. This gives you a clear audit trail, a reviewed migration, and the ability to test the rollback before deploying it.

So what are down migrations for?

**Development.** When you're working on a feature branch that adds a table, and you need to switch to another branch that doesn't have that table, pgmagmig rolls back your migration and applies the other branch's migrations. When you switch back, it rolls back those and reapplies yours. This happens automatically when you run `pgmagmig migrate` — it compares the migration files on disk to what's recorded in the database and figures out the minimal set of rollbacks and applies.

**Thinking through reversibility.** Even if you never run a down migration in production, the act of writing one forces you to think about whether your change is reversible. A migration that adds a column has a straightforward reversal (drop the column). A migration that drops a column doesn't — the data is gone. Writing the down SQL (or explicitly choosing to omit it) is a design decision, not busywork.

**Emergency preparedness.** If something goes wrong in production and you need to undo a migration, the down SQL already exists. You won't use it directly (you'll wrap it in a new forward migration), but having the SQL ready is better than writing it under pressure at 3am.

## Branch switching

The typical development loop:

```bash
# On feature-branch-a, apply its migrations
pgmagmig migrate \
  --migrations-dir ./migrations \
  --database-url postgres://localhost/mydb \
  --allow-rollback

# Switch to feature-branch-b
git checkout feature-branch-b

# Migrate again — pgmagmig rolls back branch-a's migrations
# and applies branch-b's
pgmagmig migrate \
  --migrations-dir ./migrations \
  --database-url postgres://localhost/mydb \
  --allow-rollback
```

The `--allow-rollback` flag is required because down migrations are inherently destructive (they drop tables, columns, etc.). pgmagmig won't run them unless you explicitly opt in.

Without `--allow-rollback`, pgmagmig prints the plan (what it would roll back and apply) and exits with a non-zero status. This is useful in CI where you want to verify the database is in sync without accidentally running destructive operations.

## Drafting migrations

The `draft-migration` command generates a migration from the diff between your current migrations and a target schema:

```bash
pgmagmig draft-migration \
  --migrations-dir ./migrations \
  --to-sql schema.sql \
  --title "Add orders table" \
  --allow-hazards all
```

The generated file includes:

- **`up` SQL** — the DDL to apply the change, with `-- HAZARD` comments on risky statements.
- **`down` SQL** — the DDL to reverse the change.
- **`invalid: true`** — a marker that prevents the migration from being applied until you've reviewed it. Remove this line after review.

Both directions are validated by roundtripping through PGlite.

If you prefer to write migrations by hand, that works too — the file format is simple YAML.

## Using the ephemeral database

The `run` command builds a PGlite database from your migrations and exposes it via Unix socket:

```bash
pgmagmig run \
  --from-migrations-dir ./migrations \
  --command "npx prisma db pull"
```

This is useful for:

- **Prisma introspection** against your migration-defined schema.
- **Code generation** tools like sqlc or pgtyped.
- **Ad-hoc queries** with psql: `pgmagmig run --from-migrations-dir ./migrations --command 'psql "$DATABASE_URL"'`

The database is ephemeral — it exists only for the duration of the command. No server to start, no port to configure, no cleanup needed.

## CI integration

A typical CI pipeline:

```bash
# Check that the database is in sync with migrations
pgmagmig migrate \
  --migrations-dir ./migrations \
  --database-url $DATABASE_URL \
  --check

# Check for unexpected hazards in the latest migration
pgmagmig diff \
  --from-migrations-dir ./migrations \
  --to-sql schema.sql \
  --check-hazards \
  --allow-hazards IndexBuild
```

The `--check` flag on `migrate` exits non-zero if any migrations are pending. The `--check-hazards` flag on `diff` exits non-zero if the diff produces any hazards not in the allow-list.
