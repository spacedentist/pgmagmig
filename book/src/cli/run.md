# run

Build a PGlite database from a schema source, expose it via Unix socket (or TCP), and run a shell command with `DATABASE_URL` set.

## Usage

```bash
# Run Prisma introspection against your migrations
pgmagmig run \
  --from-migrations-dir ./migrations \
  --command "npx prisma db pull"

# Run sqlc against a SQL schema
pgmagmig run \
  --from-sql schema.sql \
  --command "sqlc generate"

# Interactive psql session
pgmagmig run \
  --from-migrations-dir ./migrations \
  --command 'psql "$DATABASE_URL"'

# Use TCP instead of Unix socket
pgmagmig run \
  --from-sql schema.sql \
  --host 127.0.0.1 \
  --command "my-tool --db-url \$DATABASE_URL"
```

## Options

| Option | Description |
|--------|-------------|
| `--command <cmd>` | **(required)** Shell command to run |
| `--from-sql <files...>` | SQL files to apply (preserves data and non-schema statements) |
| `--from-json <file>` | JSON schema file |
| `--from-empty` | Empty database |
| `--from-database <url>` | Extract schema from live database, recreate in PGlite |
| `--from-migrations-dir <path>` | Apply migration files to PGlite (preserves raw SQL) |
| `--host <host>` | Bind address (enables TCP instead of Unix socket) |
| `--port <port>` | TCP port (default: `0` for ephemeral, only with `--host`) |

Exactly one `--from-*` option is required.

## Connection mode

**By default**, PGlite is exposed via a Unix domain socket in a temporary directory. This is fast, avoids port conflicts, and works with most PostgreSQL client libraries.

**With `--host`**, PGlite is exposed via TCP on the specified address. Use this for tools that don't support Unix socket connections.

The `DATABASE_URL` environment variable is set accordingly:

- Unix socket: `postgresql://postgres:postgres@/postgres?host=/tmp/pgmagmig-XXXXXX`
- TCP: `postgresql://postgres:postgres@127.0.0.1:PORT/postgres`

## SQL preservation

For `--from-sql` and `--from-migrations-dir`, the raw SQL is applied directly to PGlite. This preserves INSERT statements, GRANTs, and other non-schema SQL. For other sources (`--from-json`, `--from-database`), the schema is extracted and regenerated as DDL.

## Exit code

The command's exit code is propagated:

- Child exits normally → pgmagmig exits with the same code.
- Child killed by a signal → pgmagmig exits with `128 + signal number`.

## Signal handling

`SIGINT` and `SIGTERM` received by pgmagmig are forwarded to the child process. After the child exits, the PGlite instance and socket are cleaned up.
