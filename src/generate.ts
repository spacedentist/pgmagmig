import { escapeLiteral } from "./escape.js";
import type {
  Column,
  DatabaseSchema,
  SequenceOptions,
  Table,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function generateDdl(schema: DatabaseSchema): string {
  const stmts = generateDdlStatements(schema);
  if (stmts.length === 0) return "";
  return stmts.join(";\n") + ";\n";
}

export function generateDdlStatements(schema: DatabaseSchema): string[] {
  const stmts: string[] = [];

  // 1. Schemas
  for (const s of Object.values(schema.schemas)) {
    if (s.name !== "public") {
      stmts.push(`CREATE SCHEMA ${s.name}`);
    }
  }

  // 2. Extensions
  for (const ext of Object.values(schema.extensions)) {
    let sql = `CREATE EXTENSION IF NOT EXISTS ${escapeExtName(ext.name)}`;
    if (ext.schema && ext.schema !== "public") {
      sql += ` SCHEMA ${ext.schema}`;
    }
    stmts.push(sql);
  }

  // 3. Enums
  for (const e of Object.values(schema.enums)) {
    const vals = e.values.map(escapeLiteral).join(", ");
    stmts.push(`CREATE TYPE ${e.schema}.${e.name} AS ENUM (${vals})`);
  }

  // 4. Sequences (standalone + implicit from columns)
  for (const seq of Object.values(schema.sequences)) {
    stmts.push(createSequenceDdl(`${seq.schema}.${seq.name}`, seq));
  }
  for (const table of Object.values(schema.tables)) {
    for (const col of table.columns) {
      if (col.sequenceName && col.sequenceOptions) {
        stmts.push(createSequenceDdl(col.sequenceName, col.sequenceOptions));
      }
    }
  }

  // 5. Tables (bare: columns + NOT NULL only)
  for (const table of Object.values(schema.tables)) {
    stmts.push(createBareTableDdl(table));
  }

  // 6. Functions (after bare tables so SQL-language functions that
  //    reference tables can be validated by PG17)
  for (const overloads of Object.values(schema.functions)) {
    for (const fn of overloads) {
      stmts.push(fn.definition);
    }
  }

  // 7. ALTER SEQUENCE … OWNED BY (implicit sequences)
  for (const table of Object.values(schema.tables)) {
    const qTable = `${table.schema}.${table.name}`;
    for (const col of table.columns) {
      if (col.sequenceName && col.sequenceOptions) {
        stmts.push(
          `ALTER SEQUENCE ${col.sequenceName} OWNED BY ${qTable}.${col.name}`,
        );
      }
    }
  }

  // 8. Column defaults
  for (const table of Object.values(schema.tables)) {
    const qTable = `${table.schema}.${table.name}`;
    for (const col of table.columns) {
      if (col.defaultValue !== null && !col.isGenerated) {
        stmts.push(
          `ALTER TABLE ${qTable} ALTER COLUMN ${col.name} SET DEFAULT ${col.defaultValue}`,
        );
      }
    }
  }

  // 9. Indexes (verbatim definition)
  for (const idx of Object.values(schema.indexes)) {
    stmts.push(idx.definition);
  }

  // 10. Non-FK constraints
  for (const table of Object.values(schema.tables)) {
    const qTable = `${table.schema}.${table.name}`;
    for (const con of table.constraints) {
      if (con.type !== "FOREIGN KEY") {
        stmts.push(
          `ALTER TABLE ${qTable} ADD CONSTRAINT ${con.name} ${con.definition}`,
        );
      }
    }
  }

  // 11. FK constraints
  for (const table of Object.values(schema.tables)) {
    const qTable = `${table.schema}.${table.name}`;
    for (const con of table.constraints) {
      if (con.type === "FOREIGN KEY") {
        stmts.push(
          `ALTER TABLE ${qTable} ADD CONSTRAINT ${con.name} ${con.definition}`,
        );
      }
    }
  }

  // 12. Views
  for (const view of Object.values(schema.views)) {
    stmts.push(
      `CREATE VIEW ${view.schema}.${view.name} AS ${view.definition}`,
    );
  }

  // 13. Triggers
  for (const trigger of Object.values(schema.triggers)) {
    stmts.push(trigger.definition);
  }

  return stmts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSequenceDdl(
  qualifiedName: string,
  opts: SequenceOptions,
): string {
  let sql = `CREATE SEQUENCE ${qualifiedName}`;
  sql += ` AS ${opts.dataType}`;
  sql += ` START WITH ${opts.startValue}`;
  sql += ` INCREMENT BY ${opts.increment}`;
  sql += ` MINVALUE ${opts.minValue}`;
  sql += ` MAXVALUE ${opts.maxValue}`;
  sql += ` CACHE ${opts.cacheSize}`;
  sql += opts.cycle ? " CYCLE" : " NO CYCLE";
  return sql;
}

function createBareTableDdl(table: Table): string {
  const qTable = `${table.schema}.${table.name}`;
  const colDefs = table.columns.map((col) => bareColumnDdl(col));
  return `CREATE TABLE ${qTable} (\n  ${colDefs.join(",\n  ")}\n)`;
}

function bareColumnDdl(col: Column): string {
  let ddl = `${col.name} ${col.dataType}`;

  if (col.identity) {
    const kind = col.identity.always ? "ALWAYS" : "BY DEFAULT";
    ddl += ` GENERATED ${kind} AS IDENTITY`;
  } else if (col.isGenerated && col.generationExpression) {
    ddl += ` GENERATED ALWAYS AS (${col.generationExpression}) STORED`;
  }

  if (!col.isNullable) {
    ddl += " NOT NULL";
  }

  return ddl;
}

function escapeExtName(name: string): string {
  if (/^[a-z_][a-z0-9_]*$/.test(name)) return name;
  return `"${name.replace(/"/g, '""')}"`;
}
