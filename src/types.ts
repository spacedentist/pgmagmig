// ---------------------------------------------------------------------------
// Queryable — shared interface satisfied by both PGlite and pg.Client
// ---------------------------------------------------------------------------

export interface Queryable {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

// ---------------------------------------------------------------------------
// Schema data model — all identifiers are pre-quoted via quote_ident()
// ---------------------------------------------------------------------------

export interface DatabaseSchema {
  extensions: Record<string, Extension>;
  schemas: Record<string, Schema>;
  enums: Record<string, Enum>;
  sequences: Record<string, Sequence>;
  tables: Record<string, Table>;
  views: Record<string, View>;
  functions: Record<string, FunctionDef[]>;
  triggers: Record<string, Trigger>;
  indexes: Record<string, Index>;
  /**
   * Cross-object dependency edges read from `pg_depend` (deptype 'n'). Each
   * edge says "dependent must be created after the object providing
   * `referenced`". Populated by extraction; empty for schemas built any other
   * way (e.g. from JSON), in which case the differ falls back to bucket order.
   */
  dependencies: SchemaDependency[];
}

/** A single `pg_depend` edge, mapped back to the object we emit DDL for. */
export interface SchemaDependency {
  dependent: DependentRef;
  /** Capability provided by the referenced object, e.g. `enum:public.mood`. */
  referenced: string;
}

export interface DependentRef {
  kind: "column" | "default" | "constraint" | "index" | "trigger" | "view" | "function";
  /** Owning table key, for column/default/constraint/index. */
  table: string | null;
  /** Column/constraint name, for column/default/constraint. */
  name: string | null;
  /** Object key, for index/view/function/trigger (the map key each uses). */
  key: string | null;
  /** Function identity arguments, for function dependents. */
  identity: string | null;
}

export interface Extension {
  name: string;
  version: string | null;
  schema: string;
}

export interface Schema {
  name: string;
}

export interface Enum {
  schema: string;
  name: string;
  values: string[];
}

export interface SequenceOptions {
  dataType: string;
  startValue: string;
  minValue: string;
  maxValue: string;
  increment: string;
  cacheSize: string;
  cycle: boolean;
}

export interface Sequence extends SequenceOptions {
  schema: string;
  name: string;
  ownedByTable: string | null;
  ownedByColumn: string | null;
}

export interface Table {
  schema: string;
  name: string;
  columns: Column[];
  constraints: Constraint[];
}

export interface Column {
  name: string;
  dataType: string;
  isNullable: boolean;
  defaultValue: string | null;
  sequenceName: string | null;
  sequenceOptions: SequenceOptions | null;
  identity: IdentityInfo | null;
  isGenerated: boolean;
  generationExpression: string | null;
}

export interface IdentityInfo {
  always: boolean;
  sequenceName: string;
  sequenceOptions: SequenceOptions;
}

export type ConstraintType =
  | "PRIMARY KEY"
  | "UNIQUE"
  | "CHECK"
  | "FOREIGN KEY"
  | "EXCLUDE";

export interface Constraint {
  name: string;
  type: ConstraintType;
  columns: string[];
  definition: string;
  referencedTable: string | null;
  referencedColumns: string[];
  onUpdate: string | null;
  onDelete: string | null;
  checkExpression: string | null;
}

export interface Index {
  schema: string;
  name: string;
  tableName: string;
  definition: string;
}

export interface View {
  schema: string;
  name: string;
  definition: string;
}

export interface FunctionDef {
  schema: string;
  name: string;
  identity: string;
  definition: string;
}

export interface Trigger {
  schema: string;
  name: string;
  tableName: string;
  definition: string;
}

// ---------------------------------------------------------------------------
// Diff output types
// ---------------------------------------------------------------------------

export type HazardType =
  | "AcquiresAccessExclusiveLock"
  | "AcquiresShareLock"
  | "AcquiresShareRowExclusiveLock"
  | "DeletesData"
  | "IndexDropped"
  | "IndexBuild"
  | "ImpactsDatabasePerformance"
  | "Correctness"
  | "HasUntrackableDependencies"
  | "RequiresPopulatedTableScan";

export interface Hazard {
  type: HazardType;
  message: string;
}

export interface Statement {
  ddl: string;
  hazards: Hazard[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationError {
  path: string;
  expected: unknown;
  actual: unknown;
  message: string;
}

// ---------------------------------------------------------------------------
// Migration files
// ---------------------------------------------------------------------------

export interface MigrationFile {
  sequence: number;
  uuid: string;
  title: string;
  up: string;
  down: string | null;
  invalid?: boolean;
  filename: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function emptySchema(): DatabaseSchema {
  return {
    extensions: {},
    schemas: { public: { name: "public" } },
    enums: {},
    sequences: {},
    tables: {},
    views: {},
    functions: {},
    triggers: {},
    indexes: {},
    dependencies: [],
  };
}
