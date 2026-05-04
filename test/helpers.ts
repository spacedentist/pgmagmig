import { extractSchema } from "../src/extract.js";
import { splitSql } from "../src/split-sql.js";
import type { DatabaseSchema, Queryable } from "../src/types.js";

/**
 * Apply SQL within a transaction, extract the schema, then ROLLBACK.
 * The PGlite instance is left clean for the next test.
 */
export async function schemaFromSql(
  db: Queryable,
  sql: string,
): Promise<DatabaseSchema> {
  await db.query("BEGIN");
  try {
    for (const stmt of splitSql(sql)) {
      await db.query(stmt);
    }
    return await extractSchema(db);
  } finally {
    await db.query("ROLLBACK");
  }
}

/**
 * Apply "from" SQL + diff DDL within a transaction, extract, then ROLLBACK.
 */
export async function applyDiffAndExtract(
  db: Queryable,
  fromSql: string,
  diffDdl: string,
): Promise<DatabaseSchema> {
  await db.query("BEGIN");
  try {
    if (fromSql) {
      for (const stmt of splitSql(fromSql)) {
        await db.query(stmt);
      }
    }
    if (diffDdl) {
      for (const stmt of splitSql(diffDdl)) {
        await db.query(stmt);
      }
    }
    return await extractSchema(db);
  } finally {
    await db.query("ROLLBACK");
  }
}
