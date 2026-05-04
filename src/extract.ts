import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { escapeLiteral } from "./escape.js";
import type {
  Column,
  Constraint,
  ConstraintType,
  DatabaseSchema,
  Enum,
  Extension,
  FunctionDef,
  IdentityInfo,
  Index,
  Queryable,
  Schema,
  Sequence,
  SequenceOptions,
  Table,
  Trigger,
  View,
} from "./types.js";
import { splitSql } from "./split-sql.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SYSTEM_SCHEMAS = [
  "pg_catalog",
  "information_schema",
  "pg_toast",
  "pg_temp_1",
  "pg_toast_temp_1",
];

const SCHEMA_FILTER = `n.nspname NOT IN (${SYSTEM_SCHEMAS.map(escapeLiteral).join(", ")})`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJsonArray(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return JSON.parse(value) as unknown[];
  return [];
}

function toBool(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}

function toStr(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function toStrOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function qualifiedName(schema: string, name: string): string {
  return `${schema}.${name}`;
}

const FK_ACTIONS: Record<string, string> = {
  a: "NO ACTION",
  r: "RESTRICT",
  c: "CASCADE",
  n: "SET NULL",
  d: "SET DEFAULT",
};

const CONSTRAINT_TYPES: Record<string, ConstraintType> = {
  p: "PRIMARY KEY",
  u: "UNIQUE",
  c: "CHECK",
  f: "FOREIGN KEY",
  x: "EXCLUDE",
};

// ---------------------------------------------------------------------------
// Individual extractors
// ---------------------------------------------------------------------------

async function extractSchemas(db: Queryable): Promise<Record<string, Schema>> {
  const { rows } = await db.query<{ name: string }>(`
    SELECT quote_ident(n.nspname) AS name
    FROM pg_namespace n
    WHERE ${SCHEMA_FILTER}
    ORDER BY n.nspname
  `);
  const result: Record<string, Schema> = {};
  for (const row of rows) {
    result[row.name] = { name: row.name };
  }
  return result;
}

async function extractExtensions(
  db: Queryable,
): Promise<Record<string, Extension>> {
  const { rows } = await db.query<{
    name: string;
    version: string | null;
    schema_name: string;
  }>(`
    SELECT
      e.extname AS name,
      e.extversion AS version,
      quote_ident(n.nspname) AS schema_name
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname != 'plpgsql'
    ORDER BY e.extname
  `);
  const result: Record<string, Extension> = {};
  for (const row of rows) {
    result[row.name] = {
      name: row.name,
      version: toStrOrNull(row.version),
      schema: row.schema_name,
    };
  }
  return result;
}

async function extractEnums(db: Queryable): Promise<Record<string, Enum>> {
  const { rows } = await db.query<{
    schema_name: string;
    enum_name: string;
    values: unknown;
  }>(`
    SELECT
      quote_ident(n.nspname) AS schema_name,
      quote_ident(t.typname) AS enum_name,
      COALESCE(
        jsonb_agg(e.enumlabel ORDER BY e.enumsortorder),
        '[]'::jsonb
      ) AS values
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    LEFT JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typcategory = 'E'
      AND ${SCHEMA_FILTER}
    GROUP BY n.nspname, t.typname
    ORDER BY n.nspname, t.typname
  `);
  const result: Record<string, Enum> = {};
  for (const row of rows) {
    const key = qualifiedName(row.schema_name, row.enum_name);
    result[key] = {
      schema: row.schema_name,
      name: row.enum_name,
      values: parseJsonArray(row.values) as string[],
    };
  }
  return result;
}

async function extractSequences(
  db: Queryable,
): Promise<Record<string, Sequence>> {
  const { rows } = await db.query<{
    schema_name: string;
    sequence_name: string;
    data_type: string;
    start_value: unknown;
    min_value: unknown;
    max_value: unknown;
    increment: unknown;
    cache_size: unknown;
    cycle: unknown;
  }>(`
    SELECT
      quote_ident(n.nspname) AS schema_name,
      quote_ident(c.relname) AS sequence_name,
      format_type(s.seqtypid, 0) AS data_type,
      s.seqstart AS start_value,
      s.seqmin AS min_value,
      s.seqmax AS max_value,
      s.seqincrement AS increment,
      s.seqcache AS cache_size,
      s.seqcycle AS cycle
    FROM pg_sequence s
    JOIN pg_class c ON c.oid = s.seqrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'S'
      AND ${SCHEMA_FILTER}
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend dep
        WHERE dep.objid = s.seqrelid
          AND dep.deptype IN ('a', 'i')
          AND dep.refobjsubid > 0
      )
    ORDER BY n.nspname, c.relname
  `);
  const result: Record<string, Sequence> = {};
  for (const row of rows) {
    const key = qualifiedName(row.schema_name, row.sequence_name);
    result[key] = {
      schema: row.schema_name,
      name: row.sequence_name,
      dataType: row.data_type,
      startValue: toStr(row.start_value),
      minValue: toStr(row.min_value),
      maxValue: toStr(row.max_value),
      increment: toStr(row.increment),
      cacheSize: toStr(row.cache_size),
      cycle: toBool(row.cycle),
      ownedByTable: null,
      ownedByColumn: null,
    };
  }
  return result;
}

interface ColumnRow {
  schema_name: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: unknown;
  default_value: string | null;
  attidentity: string;
  attgenerated: string;
  generation_expression: string | null;
  seq_name: string | null;
  seq_deptype: string | null;
  seq_data_type: string | null;
  seq_start: unknown;
  seq_min: unknown;
  seq_max: unknown;
  seq_increment: unknown;
  seq_cache: unknown;
  seq_cycle: unknown;
}

async function extractColumns(db: Queryable): Promise<Map<string, Column[]>> {
  const { rows } = await db.query<ColumnRow>(`
    SELECT
      quote_ident(n.nspname) AS schema_name,
      quote_ident(c.relname) AS table_name,
      quote_ident(a.attname) AS column_name,
      format_type(a.atttypid, a.atttypmod) AS data_type,
      NOT a.attnotnull AS is_nullable,
      CASE
        WHEN a.attgenerated = '' THEN pg_get_expr(d.adbin, d.adrelid)
        ELSE NULL
      END AS default_value,
      a.attidentity,
      a.attgenerated,
      CASE
        WHEN a.attgenerated = 's' THEN pg_get_expr(d.adbin, d.adrelid)
        ELSE NULL
      END AS generation_expression,
      seq_info.seq_name,
      seq_info.seq_deptype,
      seq_info.seq_data_type,
      seq_info.seq_start,
      seq_info.seq_min,
      seq_info.seq_max,
      seq_info.seq_increment,
      seq_info.seq_cache,
      seq_info.seq_cycle
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
      AND a.attnum > 0
      AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    LEFT JOIN LATERAL (
      SELECT
        quote_ident(sn.nspname) || '.' || quote_ident(sc.relname) AS seq_name,
        dep.deptype AS seq_deptype,
        format_type(s.seqtypid, 0) AS seq_data_type,
        s.seqstart AS seq_start,
        s.seqmin AS seq_min,
        s.seqmax AS seq_max,
        s.seqincrement AS seq_increment,
        s.seqcache AS seq_cache,
        s.seqcycle AS seq_cycle
      FROM pg_depend dep
      JOIN pg_class sc ON sc.oid = dep.objid AND sc.relkind = 'S'
      JOIN pg_namespace sn ON sn.oid = sc.relnamespace
      JOIN pg_sequence s ON s.seqrelid = dep.objid
      WHERE dep.refobjid = a.attrelid
        AND dep.refobjsubid = a.attnum
        AND dep.deptype IN ('a', 'i')
      LIMIT 1
    ) seq_info ON true
    WHERE c.relkind = 'r'
      AND ${SCHEMA_FILTER}
    ORDER BY n.nspname, c.relname, a.attnum
  `);

  const tableColumns = new Map<string, Column[]>();
  for (const row of rows) {
    const tableKey = qualifiedName(row.schema_name, row.table_name);

    let seqOptions: SequenceOptions | null = null;
    if (row.seq_name) {
      seqOptions = {
        dataType: row.seq_data_type ?? "bigint",
        startValue: toStr(row.seq_start),
        minValue: toStr(row.seq_min),
        maxValue: toStr(row.seq_max),
        increment: toStr(row.seq_increment),
        cacheSize: toStr(row.seq_cache),
        cycle: toBool(row.seq_cycle),
      };
    }

    let identity: IdentityInfo | null = null;
    if (row.attidentity === "a" || row.attidentity === "d") {
      identity = {
        always: row.attidentity === "a",
        sequenceName: row.seq_name ?? "",
        sequenceOptions: seqOptions ?? {
          dataType: "bigint",
          startValue: "1",
          minValue: "1",
          maxValue: "9223372036854775807",
          increment: "1",
          cacheSize: "1",
          cycle: false,
        },
      };
    }

    const isSerial = !identity && row.seq_name && row.seq_deptype === "a";

    const col: Column = {
      name: row.column_name,
      dataType: row.data_type,
      isNullable: toBool(row.is_nullable),
      defaultValue: row.default_value ?? null,
      sequenceName: isSerial ? row.seq_name : null,
      sequenceOptions: isSerial ? seqOptions : null,
      identity,
      isGenerated: row.attgenerated === "s",
      generationExpression: row.generation_expression ?? null,
    };

    let cols = tableColumns.get(tableKey);
    if (!cols) {
      cols = [];
      tableColumns.set(tableKey, cols);
    }
    cols.push(col);
  }

  return tableColumns;
}

interface ConstraintRow {
  schema_name: string;
  table_name: string;
  constraint_name: string;
  contype: string;
  definition: string;
  columns: unknown;
  referenced_table: string | null;
  referenced_columns: unknown;
  confupdtype: string | null;
  confdeltype: string | null;
  check_expression: string | null;
}

async function extractConstraints(
  db: Queryable,
): Promise<Map<string, Constraint[]>> {
  const { rows } = await db.query<ConstraintRow>(`
    SELECT
      quote_ident(n.nspname) AS schema_name,
      quote_ident(cl.relname) AS table_name,
      quote_ident(con.conname) AS constraint_name,
      con.contype,
      pg_get_constraintdef(con.oid) AS definition,
      COALESCE(
        (SELECT jsonb_agg(quote_ident(a.attname) ORDER BY array_position(con.conkey, a.attnum))
         FROM pg_attribute a
         WHERE a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)),
        '[]'::jsonb
      ) AS columns,
      CASE WHEN con.contype = 'f' THEN
        quote_ident(fn.nspname) || '.' || quote_ident(fcl.relname)
      ELSE NULL END AS referenced_table,
      CASE WHEN con.contype = 'f' THEN
        COALESCE(
          (SELECT jsonb_agg(quote_ident(a.attname) ORDER BY array_position(con.confkey, a.attnum))
           FROM pg_attribute a
           WHERE a.attrelid = con.confrelid AND a.attnum = ANY(con.confkey)),
          '[]'::jsonb
        )
      ELSE '[]'::jsonb END AS referenced_columns,
      con.confupdtype,
      con.confdeltype,
      CASE WHEN con.contype = 'c' THEN
        pg_get_expr(con.conbin, con.conrelid)
      ELSE NULL END AS check_expression
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    LEFT JOIN pg_class fcl ON fcl.oid = con.confrelid
    LEFT JOIN pg_namespace fn ON fn.oid = fcl.relnamespace
    WHERE ${SCHEMA_FILTER}
    ORDER BY n.nspname, cl.relname, con.conname
  `);

  const tableConstraints = new Map<string, Constraint[]>();
  for (const row of rows) {
    const tableKey = qualifiedName(row.schema_name, row.table_name);
    const conType = CONSTRAINT_TYPES[row.contype];
    if (!conType) continue;

    const constraint: Constraint = {
      name: row.constraint_name,
      type: conType,
      columns: parseJsonArray(row.columns) as string[],
      definition: row.definition,
      referencedTable: row.referenced_table ?? null,
      referencedColumns: parseJsonArray(row.referenced_columns) as string[],
      onUpdate: row.confupdtype ? (FK_ACTIONS[row.confupdtype] ?? null) : null,
      onDelete: row.confdeltype ? (FK_ACTIONS[row.confdeltype] ?? null) : null,
      checkExpression: row.check_expression ?? null,
    };

    let cons = tableConstraints.get(tableKey);
    if (!cons) {
      cons = [];
      tableConstraints.set(tableKey, cons);
    }
    cons.push(constraint);
  }

  return tableConstraints;
}

async function extractTables(
  db: Queryable,
  columns: Map<string, Column[]>,
  constraints: Map<string, Constraint[]>,
): Promise<Record<string, Table>> {
  const { rows } = await db.query<{
    schema_name: string;
    table_name: string;
  }>(`
    SELECT
      quote_ident(n.nspname) AS schema_name,
      quote_ident(c.relname) AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r'
      AND ${SCHEMA_FILTER}
    ORDER BY n.nspname, c.relname
  `);

  const result: Record<string, Table> = {};
  for (const row of rows) {
    const key = qualifiedName(row.schema_name, row.table_name);
    result[key] = {
      schema: row.schema_name,
      name: row.table_name,
      columns: columns.get(key) ?? [],
      constraints: constraints.get(key) ?? [],
    };
  }
  return result;
}

async function extractIndexes(
  db: Queryable,
): Promise<Record<string, Index>> {
  const { rows } = await db.query<{
    schema_name: string;
    index_name: string;
    table_name: string;
    definition: string;
  }>(`
    SELECT
      quote_ident(n.nspname) AS schema_name,
      quote_ident(ic.relname) AS index_name,
      quote_ident(tn.nspname) || '.' || quote_ident(tc.relname) AS table_name,
      pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_class tc ON tc.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = ic.relnamespace
    JOIN pg_namespace tn ON tn.oid = tc.relnamespace
    WHERE ${SCHEMA_FILTER}
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint con
        WHERE con.conindid = i.indexrelid
      )
    ORDER BY n.nspname, ic.relname
  `);

  const result: Record<string, Index> = {};
  for (const row of rows) {
    const key = qualifiedName(row.schema_name, row.index_name);
    result[key] = {
      schema: row.schema_name,
      name: row.index_name,
      tableName: row.table_name,
      definition: row.definition,
    };
  }
  return result;
}

async function extractViews(db: Queryable): Promise<Record<string, View>> {
  const { rows } = await db.query<{
    schema_name: string;
    view_name: string;
    definition: string;
  }>(`
    SELECT
      quote_ident(n.nspname) AS schema_name,
      quote_ident(c.relname) AS view_name,
      pg_get_viewdef(c.oid) AS definition
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'v'
      AND ${SCHEMA_FILTER}
    ORDER BY n.nspname, c.relname
  `);

  const result: Record<string, View> = {};
  for (const row of rows) {
    const key = qualifiedName(row.schema_name, row.view_name);
    result[key] = {
      schema: row.schema_name,
      name: row.view_name,
      definition: row.definition,
    };
  }
  return result;
}

async function extractFunctions(
  db: Queryable,
): Promise<Record<string, FunctionDef[]>> {
  const { rows } = await db.query<{
    schema_name: string;
    function_name: string;
    identity: string;
    definition: string;
  }>(`
    SELECT
      quote_ident(n.nspname) AS schema_name,
      quote_ident(p.proname) AS function_name,
      pg_get_function_identity_arguments(p.oid) AS identity,
      pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE ${SCHEMA_FILTER}
      AND p.prokind IN ('f', 'p')
    ORDER BY n.nspname, p.proname
  `);

  const result: Record<string, FunctionDef[]> = {};
  for (const row of rows) {
    const key = qualifiedName(row.schema_name, row.function_name);
    const fn: FunctionDef = {
      schema: row.schema_name,
      name: row.function_name,
      identity: row.identity,
      definition: row.definition,
    };
    if (!result[key]) {
      result[key] = [];
    }
    result[key].push(fn);
  }
  return result;
}

async function extractTriggers(
  db: Queryable,
): Promise<Record<string, Trigger>> {
  const { rows } = await db.query<{
    schema_name: string;
    trigger_name: string;
    table_name: string;
    definition: string;
  }>(`
    SELECT
      quote_ident(n.nspname) AS schema_name,
      quote_ident(t.tgname) AS trigger_name,
      quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS table_name,
      pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal
      AND ${SCHEMA_FILTER}
    ORDER BY n.nspname, t.tgname
  `);

  const result: Record<string, Trigger> = {};
  for (const row of rows) {
    const key = `${row.schema_name}.${row.trigger_name}@${row.table_name}`;
    result[key] = {
      schema: row.schema_name,
      name: row.trigger_name,
      tableName: row.table_name,
      definition: row.definition,
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main extraction
// ---------------------------------------------------------------------------

export async function extractSchema(db: Queryable): Promise<DatabaseSchema> {
  const [schemas, extensions, enums, sequences, cols, cons, indexes, views, functions, triggers] =
    await Promise.all([
      extractSchemas(db),
      extractExtensions(db),
      extractEnums(db),
      extractSequences(db),
      extractColumns(db),
      extractConstraints(db),
      extractIndexes(db),
      extractViews(db),
      extractFunctions(db),
      extractTriggers(db),
    ]);

  const tables = await extractTables(db, cols, cons);

  return {
    schemas,
    extensions,
    enums,
    sequences,
    tables,
    views,
    functions,
    triggers,
    indexes,
  };
}

// ---------------------------------------------------------------------------
// Public wrappers
// ---------------------------------------------------------------------------

export async function extractSchemaFromSql(
  sqlStatements: string[],
): Promise<DatabaseSchema> {
  const db = new PGlite();
  try {
    for (const sql of sqlStatements) {
      const stmts = splitSql(sql);
      for (const stmt of stmts) {
        await db.query(stmt);
      }
    }
    return await extractSchema(db);
  } finally {
    await db.close();
  }
}

export async function extractSchemaFromDatabase(
  connectionString: string,
): Promise<DatabaseSchema> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const schema = await extractSchema(client);
    await client.query("ROLLBACK");
    return schema;
  } finally {
    await client.end();
  }
}
