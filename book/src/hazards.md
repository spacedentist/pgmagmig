# Hazards

When pgmagmig generates a schema diff, it tags statements that are destructive, lock-heavy, or potentially dangerous with structured **hazard** annotations. Each hazard has a machine-readable type and a human-readable message.

## Hazard types

| Type | Meaning |
|------|---------|
| `DeletesData` | Destroys user data. Includes `DROP TABLE`, `DROP COLUMN`, and generation-state changes that require dropping and recreating a column. |
| `AcquiresAccessExclusiveLock` | Acquires an ACCESS EXCLUSIVE lock, blocking all reads and writes on the table. Includes `ALTER COLUMN TYPE` and `SET EXPRESSION` (which recomputes stored values). |
| `AcquiresShareLock` | Acquires a SHARE lock, blocking writes but not reads. |
| `AcquiresShareRowExclusiveLock` | Acquires a SHARE ROW EXCLUSIVE lock, blocking concurrent DDL. |
| `RequiresPopulatedTableScan` | Scans the entire table to validate a constraint. Includes `SET NOT NULL`. |
| `IndexDropped` | Drops an index, which may degrade query performance. |
| `IndexBuild` | Builds an index, which may take a long time on large tables. |
| `ImpactsDatabasePerformance` | A general performance impact, such as a table rewrite. |
| `Correctness` | May silently break application behaviour. Includes adding a `NOT NULL` column without a default to a table that may have existing rows. |
| `HasUntrackableDependencies` | Drops an object that other objects may depend on, such as a function, view, type, or sequence. |

## Where hazards appear

### In migration files

The `draft-migration` command includes `-- HAZARD (type): message` comments in the `up` SQL:

```yaml
up: |
  -- HAZARD (DeletesData): deletes all data in column public.users.old_email
  ALTER TABLE public.users DROP COLUMN old_email;
  -- HAZARD (IndexBuild): builds index public.idx_users_name
  CREATE INDEX idx_users_name ON public.users USING btree (name);
```

These comments are preserved in the migration file for code review visibility.

### In diff output

With `pgmagmig diff --annotated`, hazard comments appear above their statements in the DDL output.

### In the structured API

`diffSchemaStatements(from, to)` returns `Statement[]` where each statement carries a `hazards: Hazard[]` array. Programmatic consumers can filter, block, or report on specific hazard types.

## Hazard gating

### draft-migration

Fails if the diff produces any hazard types not listed in `--allow-hazards`:

```bash
# Allow only IndexBuild hazards
pgmagmig draft-migration \
  --migrations-dir ./migrations \
  --to-sql schema.sql \
  --title "Add index" \
  --allow-hazards IndexBuild

# Allow all hazards
pgmagmig draft-migration ... --allow-hazards all
```

### diff --check-hazards

Exits non-zero if any hazards are present and not in the allow-list:

```bash
# CI: fail if the diff is destructive
pgmagmig diff \
  --from-migrations-dir ./migrations \
  --to-sql schema.sql \
  --check-hazards \
  --allow-hazards IndexBuild
```

### migrate

Does **not** gate on hazards. Hazard review happens at draft time; the `invalid: true` marker forces human review before a migration can be applied.

## Completeness

The hazard mapping is illustrative, not exhaustive. The canonical set of hazard-tagged patterns lives in the diff implementation and will grow over time. The goal is a reasonable best-effort to surface risk, not a guarantee that every dangerous operation is flagged.
