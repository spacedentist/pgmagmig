import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { splitSql } from "./split-sql.js";

export interface ServeOptions {
  pglite: PGlite;
  host?: string;
  port?: number;
}

export interface ServeResult {
  connectionString: string;
  close: () => Promise<void>;
}

export async function serve(opts: ServeOptions): Promise<ServeResult> {
  if (opts.host) {
    // TCP mode — user explicitly asked for a network socket
    const server = new PGLiteSocketServer({
      db: opts.pglite,
      host: opts.host,
      port: opts.port ?? 0,
    });
    await server.start();
    const hostPort = server.getServerConn();
    return {
      connectionString: `postgresql://postgres:postgres@${hostPort}/postgres`,
      close: () => server.stop(),
    };
  }

  // UDS mode — create a Unix domain socket in a temp directory
  const socketDir = await mkdtemp(join(tmpdir(), "pgmagmig-"));
  const socketPath = join(socketDir, ".s.PGSQL.5432");
  const server = new PGLiteSocketServer({
    db: opts.pglite,
    path: socketPath,
  });
  await server.start();

  return {
    connectionString: `postgresql://postgres:postgres@/postgres?host=${socketDir}`,
    close: async () => {
      await server.stop();
      await rm(socketDir, { recursive: true, force: true });
    },
  };
}

export async function runWithEphemeralDb(opts: {
  sqlStatements: string[];
  command: string;
  host?: string;
  port?: number;
}): Promise<number> {
  const db = new PGlite();

  try {
    for (const sql of opts.sqlStatements) {
      for (const stmt of splitSql(sql)) {
        await db.query(stmt);
      }
    }

    const { connectionString, close } = await serve({
      pglite: db,
      host: opts.host,
      port: opts.port,
    });

    try {
      return await runCommand(opts.command, connectionString);
    } finally {
      await close();
    }
  } finally {
    await db.close();
  }
}

function runCommand(command: string, databaseUrl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });

    const forwardSignal = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };
    process.on("SIGINT", forwardSignal);
    process.on("SIGTERM", forwardSignal);

    child.on("error", (err) => {
      process.removeListener("SIGINT", forwardSignal);
      process.removeListener("SIGTERM", forwardSignal);
      reject(err);
    });

    child.on("close", (code, signal) => {
      process.removeListener("SIGINT", forwardSignal);
      process.removeListener("SIGTERM", forwardSignal);
      if (signal) {
        resolve(128 + signalNumber(signal));
      } else {
        resolve(code ?? 1);
      }
    });
  });
}

function signalNumber(signal: string): number {
  const signals: Record<string, number> = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGTERM: 15,
  };
  return signals[signal] ?? 15;
}
