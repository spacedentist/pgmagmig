import { escapeLiteral } from "./escape.js";
import type {
  Column,
  Constraint,
  DatabaseSchema,
  Enum,
  FunctionDef,
  Hazard,
  HazardType,
  Index,
  SequenceOptions,
  Statement,
  Trigger,
  View,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function diffSchemaStatements(
  from: DatabaseSchema,
  to: DatabaseSchema,
): Statement[] {
  const atoms = generateAtoms(from, to);
  const edges = resolveEdges(atoms, from);
  const sorted = topoSort(atoms, edges);
  return combineAndRender(sorted);
}

export function diffSchema(from: DatabaseSchema, to: DatabaseSchema): string {
  const stmts = diffSchemaStatements(from, to);
  if (stmts.length === 0) return "";
  return stmts.map((s) => s.ddl).join(";\n") + ";\n";
}

export function diffSchemaAnnotated(from: DatabaseSchema, to: DatabaseSchema): string {
  const stmts = diffSchemaStatements(from, to);
  if (stmts.length === 0) return "";
  return stmts
    .map((s) => {
      const comments = s.hazards.map((hz) => `-- HAZARD (${hz.type}): ${hz.message}`).join("\n");
      return comments ? `${comments}\n${s.ddl}` : s.ddl;
    })
    .join(";\n") + ";\n";
}

// ---------------------------------------------------------------------------
// Atom type
// ---------------------------------------------------------------------------

interface Atom {
  id: string;
  kind: string;
  priority: number; // 0 = drop, 1 = create/alter
  order: number; // insertion order, for stable sorting
  target: string;
  hazards: Hazard[];
  provides: string[];
  requires: string[];
  // Data for rendering — varies by kind
  table?: string;
  column?: Column;
  columnName?: string;
  constraint?: Constraint;
  defaultExpr?: string;
  genExpr?: string;
  newType?: string;
  index?: Index;
  view?: View;
  trigger?: Trigger;
  functionDef?: FunctionDef;
  enumFrom?: Enum;
  enumTo?: Enum;
  affectedCols?: { table: string; col: string; isArray: boolean }[];
  seqName?: string;
  seqOpts?: SequenceOptions;
  seqOptsFrom?: SequenceOptions;
  schemaName?: string;
  extName?: string;
  extVersion?: string;
  extSchema?: string;
  fnIdentity?: string;
}

function hz(type: HazardType, message: string): Hazard {
  return { type, message };
}

// ---------------------------------------------------------------------------
// Atom generation
// ---------------------------------------------------------------------------

let nextOrder = 0;

function atom(partial: Omit<Atom, "order">): Atom {
  return { ...partial, order: nextOrder++ };
}

function generateAtoms(from: DatabaseSchema, to: DatabaseSchema): Atom[] {
  nextOrder = 0;
  const atoms: Atom[] = [];

  // Compute sets of objects being fully dropped so we can skip redundant
  // individual drops (DROP SCHEMA CASCADE handles its contents, DROP TABLE
  // handles its indexes/constraints)
  const droppedSchemas = new Set<string>();
  for (const key of Object.keys(from.schemas)) {
    if (!(key in to.schemas) && key !== "public") droppedSchemas.add(key);
  }
  const droppedTables = new Set<string>();
  for (const key of Object.keys(from.tables)) {
    if (!(key in to.tables)) droppedTables.add(key);
  }

  diffSchemas(from, to, atoms);
  diffExtensions(from, to, atoms);
  diffEnums(from, to, atoms);
  diffSequences(from, to, atoms);
  diffFunctions(from, to, atoms);
  diffTables(from, to, atoms, droppedSchemas);
  diffIndexes(from, to, atoms, droppedTables, droppedSchemas);
  diffViews(from, to, atoms, droppedSchemas);
  diffTriggers(from, to, atoms, droppedTables, droppedSchemas);

  return atoms;
}

function diffSchemas(from: DatabaseSchema, to: DatabaseSchema, atoms: Atom[]) {
  for (const [key, s] of Object.entries(to.schemas)) {
    if (!(key in from.schemas) && s.name !== "public") {
      atoms.push(atom({
        id: `create-schema:${key}`, kind: "create_schema", priority: 1,
        target: key, hazards: [], provides: [`schema:${key}`], requires: [],
        schemaName: s.name,
      }));
    }
  }
  for (const [key, s] of Object.entries(from.schemas)) {
    if (!(key in to.schemas) && s.name !== "public") {
      atoms.push(atom({
        id: `drop-schema:${key}`, kind: "drop_schema", priority: 0,
        target: key, hazards: [hz("DeletesData", `drops schema ${s.name} and all its objects`)],
        provides: [`dropped:schema:${key}`], requires: [], schemaName: s.name,
      }));
    }
  }
}

function diffExtensions(from: DatabaseSchema, to: DatabaseSchema, atoms: Atom[]) {
  for (const [key, ext] of Object.entries(to.extensions)) {
    if (!(key in from.extensions)) {
      atoms.push(atom({
        id: `create-ext:${key}`, kind: "create_extension", priority: 1,
        target: key, hazards: [], provides: [`extension:${key}`],
        requires: ext.schema !== "public" ? [`schema:${ext.schema}`] : [],
        extName: ext.name, extSchema: ext.schema,
      }));
    } else if (from.extensions[key].version !== ext.version && ext.version) {
      atoms.push(atom({
        id: `alter-ext:${key}`, kind: "alter_extension", priority: 1,
        target: key, hazards: [], provides: [], requires: [],
        extName: ext.name, extVersion: ext.version,
      }));
    }
  }
  for (const [key, ext] of Object.entries(from.extensions)) {
    if (!(key in to.extensions)) {
      atoms.push(atom({
        id: `drop-ext:${key}`, kind: "drop_extension", priority: 0,
        target: key, hazards: [hz("HasUntrackableDependencies", `drops extension ${ext.name}`)],
        provides: [], requires: [], extName: ext.name,
      }));
    }
  }
}

function diffEnums(from: DatabaseSchema, to: DatabaseSchema, atoms: Atom[]) {
  for (const [key, e] of Object.entries(to.enums)) {
    if (!(key in from.enums)) {
      atoms.push(atom({
        id: `create-enum:${key}`, kind: "create_enum", priority: 1,
        target: key, hazards: [], provides: [`enum:${key}`],
        requires: e.schema !== "public" ? [`schema:${e.schema}`] : [],
        enumTo: e,
      }));
    } else {
      const fromEnum = from.enums[key];
      if (JSON.stringify(fromEnum.values) !== JSON.stringify(e.values)) {
        const affected = findEnumColumns(to, key, e);
        const reqDrops: string[] = [];
        // Drop constraints/indexes that involve the affected enum column
        // (the enum rename invalidates type references in CHECK expressions,
        // and ALTER COLUMN TYPE may need indexes rebuilt). Only drop
        // constraints that actually reference the affected column — not
        // unrelated constraints like PKs on other columns.
        for (const ac of affected) {
          const fromTable = from.tables[ac.table];
          if (!fromTable) continue;
          const qt = `${fromTable.schema}.${fromTable.name}`;
          for (const con of fromTable.constraints) {
            if (!con.columns.includes(ac.col)) continue;
            const dropId = `drop-con-for-enum:${ac.table}.${con.name}`;
            const provKey = `dropped:constraint:${ac.table}.${con.name}`;
            atoms.push(atom({
              id: dropId, kind: "drop_constraint", priority: 0,
              target: ac.table, hazards: [], provides: [provKey],
              requires: [], table: qt, columnName: con.name,
            }));
            reqDrops.push(provKey);
          }
          for (const [iKey, idx] of Object.entries(from.indexes)) {
            if (idx.tableName !== ac.table) continue;
            // Only drop indexes that reference the affected column
            // (check if the column name appears in the index definition)
            if (!idx.definition.includes(ac.col)) continue;
            const dropId = `drop-idx-for-enum:${iKey}`;
            const provKey = `dropped:index:${iKey}`;
            atoms.push(atom({
              id: dropId, kind: "drop_index", priority: 0,
              target: ac.table, hazards: [], provides: [provKey],
              requires: [], index: idx,
            }));
            reqDrops.push(provKey);
          }
        }

        // Drop defaults on affected columns before enum swap
        for (const ac of affected) {
          const fromTable = from.tables[ac.table];
          if (!fromTable) continue;
          const fromCol = fromTable.columns.find((c) => c.name === ac.col);
          if (fromCol?.defaultValue) {
            const dropId = `drop-def-for-enum:${ac.table}.${ac.col}`;
            atoms.push(atom({
              id: dropId, kind: "drop_default", priority: 0,
              target: ac.table, hazards: [], provides: [`dropped:default-enum:${ac.table}.${ac.col}`],
              requires: [], table: ac.table, columnName: ac.col,
            }));
            reqDrops.push(`dropped:default-enum:${ac.table}.${ac.col}`);
          }
        }

        atoms.push(atom({
          id: `alter-enum:${key}`, kind: "alter_enum_values", priority: 1,
          target: key, hazards: [], provides: [`enum:${key}`, `enum-modified:${key}`],
          requires: [...new Set(reqDrops)],
          enumFrom: fromEnum, enumTo: e, affectedCols: affected,
        }));

        // Re-add defaults, constraints, and indexes after enum swap
        for (const ac of affected) {
          const toTable = to.tables[ac.table];
          if (!toTable) continue;
          const qt = `${toTable.schema}.${toTable.name}`;
          const toCol = toTable.columns.find((c) => c.name === ac.col);
          if (toCol?.defaultValue) {
            atoms.push(atom({
              id: `set-def-for-enum:${ac.table}.${ac.col}`, kind: "set_default", priority: 1,
              target: ac.table, hazards: [], provides: [],
              requires: [`enum-modified:${key}`],
              table: ac.table, columnName: ac.col, defaultExpr: toCol.defaultValue,
            }));
          }
          for (const con of toTable.constraints) {
            if (!con.columns.includes(ac.col)) continue;
            atoms.push(atom({
              id: `add-con-for-enum:${ac.table}.${con.name}`, kind: "add_constraint", priority: 1,
              target: ac.table, hazards: [], provides: [],
              requires: [`enum-modified:${key}`],
              table: qt, constraint: con,
            }));
          }
        }
        for (const ac of affected) {
          for (const [iKey, idx] of Object.entries(to.indexes)) {
            if (idx.tableName !== ac.table) continue;
            if (!idx.definition.includes(ac.col)) continue;
            atoms.push(atom({
              id: `create-idx-for-enum:${iKey}`, kind: "create_index", priority: 1,
              target: ac.table, hazards: [],
              provides: [], requires: [`enum-modified:${key}`],
              index: idx,
            }));
          }
        }
      }
    }
  }
  for (const [key, e] of Object.entries(from.enums)) {
    if (!(key in to.enums)) {
      atoms.push(atom({
        id: `drop-enum:${key}`, kind: "drop_enum", priority: 0,
        target: key, hazards: [hz("HasUntrackableDependencies", `drops enum type ${key}`)],
        provides: [], requires: [], schemaName: e.schema, columnName: e.name,
      }));
    }
  }
}

function findEnumColumns(
  schema: DatabaseSchema,
  enumKey: string,
  e: Enum,
): { table: string; col: string; isArray: boolean }[] {
  const qName = `${e.schema}.${e.name}`;
  const results: { table: string; col: string; isArray: boolean }[] = [];
  for (const [tableKey, table] of Object.entries(schema.tables)) {
    for (const col of table.columns) {
      if (col.dataType === qName || col.dataType === e.name) {
        results.push({ table: tableKey, col: col.name, isArray: false });
      } else if (col.dataType === `${qName}[]` || col.dataType === `${e.name}[]`) {
        results.push({ table: tableKey, col: col.name, isArray: true });
      }
    }
  }
  return results;
}

function diffSequences(from: DatabaseSchema, to: DatabaseSchema, atoms: Atom[]) {
  for (const [key, seq] of Object.entries(to.sequences)) {
    if (!(key in from.sequences)) {
      atoms.push(atom({
        id: `create-seq:${key}`, kind: "create_sequence", priority: 1,
        target: key, hazards: [], provides: [`sequence:${key}`],
        requires: seq.schema !== "public" ? [`schema:${seq.schema}`] : [],
        seqName: key, seqOpts: seq,
      }));
    } else if (!seqOptsEq(from.sequences[key], seq)) {
      atoms.push(atom({
        id: `alter-seq:${key}`, kind: "alter_sequence", priority: 1,
        target: key, hazards: [], provides: [], requires: [],
        seqName: key, seqOptsFrom: from.sequences[key], seqOpts: seq,
      }));
    }
  }
  for (const [key, seq] of Object.entries(from.sequences)) {
    if (!(key in to.sequences)) {
      atoms.push(atom({
        id: `drop-seq:${key}`, kind: "drop_sequence", priority: 0,
        target: key, hazards: [hz("HasUntrackableDependencies", `drops sequence ${key}`)],
        provides: [], requires: [], seqName: key,
      }));
    }
  }
}

function diffFunctions(from: DatabaseSchema, to: DatabaseSchema, atoms: Atom[]) {
  for (const [key, toOverloads] of Object.entries(to.functions)) {
    const fromOverloads = from.functions[key] ?? [];
    const fromById = new Map(fromOverloads.map((f) => [f.identity, f]));
    for (const fn of toOverloads) {
      const fromFn = fromById.get(fn.identity);
      if (!fromFn || fromFn.definition !== fn.definition) {
        const fnId = `${key}(${fn.identity})`;
        atoms.push(atom({
          id: `create-fn:${fnId}`, kind: "create_function", priority: 1,
          target: key, hazards: [], provides: [`function:${fnId}`],
          requires: fn.schema !== "public" ? [`schema:${fn.schema}`] : [],
          functionDef: fn,
        }));
      }
    }
  }
  for (const [key, fromOverloads] of Object.entries(from.functions)) {
    const toOverloads = to.functions[key] ?? [];
    const toById = new Map(toOverloads.map((f) => [f.identity, f]));
    for (const fn of fromOverloads) {
      if (!toById.has(fn.identity)) {
        const fnId = `${key}(${fn.identity})`;
        const sig = fn.identity ? `(${fn.identity})` : "()";
        atoms.push(atom({
          id: `drop-fn:${fnId}`, kind: "drop_function", priority: 0,
          target: key, hazards: [hz("HasUntrackableDependencies", `drops function ${key}`)],
          provides: [], requires: [],
          table: `${fn.schema}.${fn.name}`, fnIdentity: sig,
        }));
      }
    }
  }
}

function diffTables(from: DatabaseSchema, to: DatabaseSchema, atoms: Atom[], droppedSchemas: Set<string>) {
  // New tables: create table + columns + constraints
  for (const [key, table] of Object.entries(to.tables)) {
    if (key in from.tables) continue;
    const qt = `${table.schema}.${table.name}`;
    const schemaReq = table.schema !== "public" ? [`schema:${table.schema}`] : [];

    atoms.push(atom({
      id: `create-table:${key}`, kind: "create_table", priority: 1,
      target: key, hazards: [], provides: [`table:${key}`],
      requires: schemaReq, table: qt,
    }));

    for (const col of table.columns) {
      addColumnAtoms(key, qt, col, atoms, true);
    }
    for (const con of table.constraints) {
      addConstraintAtom(key, qt, con, atoms, true);
    }
    // Implicit sequences for new SERIAL columns
    for (const col of table.columns) {
      if (col.sequenceName && col.sequenceOptions) {
        atoms.push(atom({
          id: `create-implicit-seq:${col.sequenceName}`, kind: "create_sequence", priority: 1,
          target: key, hazards: [], provides: [`sequence:${col.sequenceName}`],
          requires: schemaReq, seqName: col.sequenceName, seqOpts: col.sequenceOptions,
        }));
        atoms.push(atom({
          id: `own-seq:${col.sequenceName}`, kind: "own_sequence", priority: 1,
          target: key, hazards: [], provides: [],
          requires: [`sequence:${col.sequenceName}`, `column:${key}.${col.name}`],
          seqName: col.sequenceName, table: qt, columnName: col.name,
        }));
      }
    }
  }

  // Altered tables
  for (const [key, toTable] of Object.entries(to.tables)) {
    const fromTable = from.tables[key];
    if (!fromTable) continue;
    const qt = `${toTable.schema}.${toTable.name}`;
    diffTableContents(key, qt, fromTable, toTable, from, atoms);
  }

  // Dropped tables
  for (const [key, table] of Object.entries(from.tables)) {
    if (key in to.tables) continue;
    // Skip if the table's schema is being dropped (CASCADE handles it)
    if (droppedSchemas.has(table.schema)) continue;
    const qt = `${table.schema}.${table.name}`;
    // Require all FK constraints from OTHER tables pointing here are dropped
    const fkDropReqs: string[] = [];
    for (const [otherKey, otherTable] of Object.entries(from.tables)) {
      if (otherKey === key) continue;
      for (const con of otherTable.constraints) {
        if (con.type === "FOREIGN KEY" && con.referencedTable === key) {
          fkDropReqs.push(`dropped:constraint:${otherKey}.${con.name}`);
        }
      }
    }
    atoms.push(atom({
      id: `drop-table:${key}`, kind: "drop_table", priority: 0,
      target: key, hazards: [hz("DeletesData", `deletes all data in table ${qt}`)],
      provides: [`dropped:table:${key}`], requires: fkDropReqs, table: qt,
    }));
  }
}

function addColumnAtoms(
  tableKey: string, qt: string, col: Column, atoms: Atom[], isNewTable: boolean,
) {
  const colKey = `${tableKey}.${col.name}`;
  const colReq = isNewTable ? [`table:${tableKey}`] : [];

  // Detect enum type dependency
  const enumReqs: string[] = [];
  for (const prefix of ["enum:", "enum:"]) {
    // We'll check both qualified forms below
  }
  // If column type looks like an enum, add dependency
  // We can't perfectly detect this without the schema, but enum types
  // are in the enums map. We'll rely on the provides/requires resolution
  // to find them.

  atoms.push(atom({
    id: `add-col:${colKey}`, kind: "add_column", priority: 1,
    target: tableKey, hazards: [],
    provides: [`column:${colKey}`], requires: colReq,
    table: qt, column: col,
  }));

  if (!col.isNullable && !col.identity) {
    atoms.push(atom({
      id: `set-nn:${colKey}`, kind: "set_not_null", priority: 1,
      target: tableKey, hazards: [],
      provides: [], requires: [`column:${colKey}`],
      table: qt, columnName: col.name,
    }));
  }

  if (col.defaultValue !== null && !col.isGenerated) {
    const defReqs = [`column:${colKey}`];
    // SERIAL default (nextval) requires the backing sequence to exist
    if (col.sequenceName) {
      defReqs.push(`sequence:${col.sequenceName}`);
    }
    atoms.push(atom({
      id: `set-def:${colKey}`, kind: "set_default", priority: 1,
      target: tableKey, hazards: [],
      provides: [`default:${colKey}`], requires: defReqs,
      table: qt, columnName: col.name, defaultExpr: col.defaultValue,
    }));
  }

  // Generated expressions are part of the ADD COLUMN definition, not a
  // separate atom. SET EXPRESSION is only for changing an existing
  // generated column's expression (handled in diffColumn).
}

function addConstraintAtom(
  tableKey: string, qt: string, con: Constraint, atoms: Atom[], isNewTable: boolean,
) {
  const conReqs: string[] = [];
  // Constraint requires its columns to exist
  for (const colName of con.columns) {
    conReqs.push(`column:${tableKey}.${colName}`);
  }
  // FK also requires referenced columns
  if (con.type === "FOREIGN KEY" && con.referencedTable) {
    for (const refCol of con.referencedColumns) {
      conReqs.push(`column:${con.referencedTable}.${refCol}`);
    }
  }

  atoms.push(atom({
    id: `add-con:${tableKey}.${con.name}`, kind: "add_constraint", priority: 1,
    target: tableKey, hazards: [],
    provides: [`constraint:${tableKey}.${con.name}`], requires: conReqs,
    table: qt, constraint: con,
  }));
}

function diffTableContents(
  key: string, qt: string, fromTable: { columns: Column[]; constraints: Constraint[] },
  toTable: { columns: Column[]; constraints: Constraint[] },
  fromSchema: DatabaseSchema, atoms: Atom[],
) {
  const fromCols = new Map(fromTable.columns.map((c) => [c.name, c]));
  const toCols = new Map(toTable.columns.map((c) => [c.name, c]));
  const fromCons = new Map(fromTable.constraints.map((c) => [c.name, c]));
  const toCons = new Map(toTable.constraints.map((c) => [c.name, c]));

  // Drop removed/changed constraints
  for (const [name, con] of fromCons) {
    const toCon = toCons.get(name);
    if (!toCon || toCon.definition !== con.definition) {
      atoms.push(atom({
        id: `drop-con:${key}.${name}`, kind: "drop_constraint", priority: 0,
        target: key, hazards: [],
        provides: [`dropped:constraint:${key}.${name}`], requires: [],
        table: qt, columnName: name,
      }));
    }
  }

  // Drop removed/changed indexes (handled in diffIndexes, not here)

  // Column changes
  for (const [name, toCol] of toCols) {
    const fromCol = fromCols.get(name);
    if (!fromCol) {
      // New column
      addColumnAtoms(key, qt, toCol, atoms, false);
      // Implicit sequence for new SERIAL column on existing table
      if (toCol.sequenceName && toCol.sequenceOptions) {
        const fromImplicit = allImplicitSeqs(fromSchema);
        if (!fromImplicit.has(toCol.sequenceName)) {
          atoms.push(atom({
            id: `create-implicit-seq:${toCol.sequenceName}`, kind: "create_sequence", priority: 1,
            target: key, hazards: [], provides: [`sequence:${toCol.sequenceName}`],
            requires: [], seqName: toCol.sequenceName, seqOpts: toCol.sequenceOptions,
          }));
          atoms.push(atom({
            id: `own-seq:${toCol.sequenceName}`, kind: "own_sequence", priority: 1,
            target: key, hazards: [], provides: [],
            requires: [`sequence:${toCol.sequenceName}`, `column:${key}.${toCol.name}`],
            seqName: toCol.sequenceName, table: qt, columnName: toCol.name,
          }));
        }
      }
      continue;
    }

    // Generation state change → drop + readd
    if (genState(fromCol) !== genState(toCol)) {
      atoms.push(atom({
        id: `drop-col:${key}.${name}`, kind: "drop_column", priority: 0,
        target: key,
        hazards: [hz("DeletesData", `drops column ${qt}.${name} for generation state change`)],
        provides: [`dropped:column:${key}.${name}`], requires: [],
        table: qt, columnName: name,
      }));
      addColumnAtoms(key, qt, toCol, atoms, false);
      continue;
    }

    // Generated expression change
    if (fromCol.isGenerated && toCol.isGenerated &&
        fromCol.generationExpression !== toCol.generationExpression) {
      atoms.push(atom({
        id: `set-gen:${key}.${name}`, kind: "set_generated", priority: 1,
        target: key,
        hazards: [hz("AcquiresAccessExclusiveLock", "recomputes stored values for every row")],
        provides: [], requires: [],
        table: qt, columnName: name, genExpr: toCol.generationExpression ?? "",
      }));
    }

    // Type change
    if (fromCol.dataType !== toCol.dataType) {
      atoms.push(atom({
        id: `alter-type:${key}.${name}`, kind: "alter_column_type", priority: 1,
        target: key,
        hazards: [hz("AcquiresAccessExclusiveLock", `rewrites table ${qt}`)],
        provides: [], requires: [],
        table: qt, columnName: name, newType: toCol.dataType,
      }));
    }

    // Nullability change
    if (fromCol.isNullable && !toCol.isNullable) {
      atoms.push(atom({
        id: `set-nn:${key}.${name}`, kind: "set_not_null", priority: 1,
        target: key,
        hazards: [hz("RequiresPopulatedTableScan", `scans entire table ${qt} to validate`)],
        provides: [], requires: [],
        table: qt, columnName: name,
      }));
    } else if (!fromCol.isNullable && toCol.isNullable) {
      atoms.push(atom({
        id: `drop-nn:${key}.${name}`, kind: "drop_not_null", priority: 1,
        target: key, hazards: [], provides: [], requires: [],
        table: qt, columnName: name,
      }));
    }

    // Default change
    if (fromCol.defaultValue !== toCol.defaultValue) {
      if (fromCol.defaultValue !== null && toCol.defaultValue === null) {
        atoms.push(atom({
          id: `drop-def:${key}.${name}`, kind: "drop_default", priority: 0,
          target: key, hazards: [], provides: [], requires: [],
          table: qt, columnName: name,
        }));
      } else if (toCol.defaultValue !== null) {
        atoms.push(atom({
          id: `set-def:${key}.${name}`, kind: "set_default", priority: 1,
          target: key, hazards: [], provides: [], requires: [],
          table: qt, columnName: name, defaultExpr: toCol.defaultValue,
        }));
      }
    }

    // Identity changes
    if (fromCol.identity && toCol.identity) {
      if (fromCol.identity.always !== toCol.identity.always) {
        const kind = toCol.identity.always ? "ALWAYS" : "BY DEFAULT";
        atoms.push(atom({
          id: `alter-identity:${key}.${name}`, kind: "alter_identity", priority: 1,
          target: key, hazards: [], provides: [], requires: [],
          table: qt, columnName: name, newType: kind,
        }));
      }
      if (!seqOptsEq(fromCol.identity.sequenceOptions, toCol.identity.sequenceOptions)) {
        atoms.push(atom({
          id: `alter-identity-seq:${key}.${name}`, kind: "alter_sequence", priority: 1,
          target: key, hazards: [], provides: [], requires: [],
          seqName: toCol.identity.sequenceName,
          seqOptsFrom: fromCol.identity.sequenceOptions,
          seqOpts: toCol.identity.sequenceOptions,
        }));
      }
    }
  }

  // Dropped columns
  for (const [name] of fromCols) {
    if (!toCols.has(name)) {
      const reqs: string[] = [];
      // Require constraints using this column to be dropped first
      for (const con of fromTable.constraints) {
        if (con.columns.includes(name)) {
          reqs.push(`dropped:constraint:${key}.${con.name}`);
        }
      }
      // Require indexes on this table to be dropped first (PG auto-drops
      // them with the column, which would cause our explicit DROP INDEX to
      // fail if it runs after)
      for (const [iKey, idx] of Object.entries(fromSchema.indexes)) {
        if (idx.tableName === key) {
          reqs.push(`dropped:index:${iKey}`);
        }
      }
      atoms.push(atom({
        id: `drop-col:${key}.${name}`, kind: "drop_column", priority: 0,
        target: key, hazards: [hz("DeletesData", `deletes all data in column ${qt}.${name}`)],
        provides: [`dropped:column:${key}.${name}`], requires: reqs,
        table: qt, columnName: name,
      }));
    }
  }

  // New/changed constraints
  for (const [name, con] of toCons) {
    const fromCon = fromCons.get(name);
    if (!fromCon || fromCon.definition !== con.definition) {
      addConstraintAtom(key, qt, con, atoms, false);
    }
  }
}

function diffIndexes(from: DatabaseSchema, to: DatabaseSchema, atoms: Atom[], droppedTables: Set<string>, droppedSchemas: Set<string>) {
  for (const [key, idx] of Object.entries(from.indexes)) {
    const toIdx = to.indexes[key];
    if (!toIdx || toIdx.definition !== idx.definition) {
      // Skip if the table or schema is being dropped (implicit cleanup)
      if (droppedTables.has(idx.tableName) || droppedSchemas.has(idx.schema)) continue;
      atoms.push(atom({
        id: `drop-idx:${key}`, kind: "drop_index", priority: 0,
        target: idx.tableName, hazards: [hz("IndexDropped", "may degrade query performance")],
        provides: [`dropped:index:${key}`], requires: [], index: idx,
      }));
    }
  }
  for (const [key, idx] of Object.entries(to.indexes)) {
    const fromIdx = from.indexes[key];
    if (!fromIdx || fromIdx.definition !== idx.definition) {
      atoms.push(atom({
        id: `create-idx:${key}`, kind: "create_index", priority: 1,
        target: idx.tableName, hazards: [hz("IndexBuild", `builds index ${key}`)],
        provides: [`index:${key}`], requires: [`table:${idx.tableName}`],
        index: idx,
      }));
    }
  }
}

function diffViews(from: DatabaseSchema, to: DatabaseSchema, atoms: Atom[], droppedSchemas: Set<string>) {
  for (const [key, view] of Object.entries(from.views)) {
    if (droppedSchemas.has(view.schema)) continue;
    const toView = to.views[key];
    if (!toView || toView.definition !== view.definition) {
      atoms.push(atom({
        id: `drop-view:${key}`, kind: "drop_view", priority: 0,
        target: key, hazards: [hz("HasUntrackableDependencies", `drops view ${key}`)],
        provides: [`dropped:view:${key}`], requires: [], view: view,
      }));
    }
  }
  for (const [key, view] of Object.entries(to.views)) {
    const fromView = from.views[key];
    if (!fromView || fromView.definition !== view.definition) {
      // Views depend on all tables (conservative — could refine with pg_depend)
      const reqs = Object.keys(to.tables).map((t) => `table:${t}`);
      atoms.push(atom({
        id: `create-view:${key}`, kind: "create_view", priority: 1,
        target: key, hazards: [], provides: [`view:${key}`], requires: reqs,
        view: view,
      }));
    }
  }
}

function diffTriggers(from: DatabaseSchema, to: DatabaseSchema, atoms: Atom[], droppedTables: Set<string>, droppedSchemas: Set<string>) {
  for (const [key, trigger] of Object.entries(from.triggers)) {
    if (droppedTables.has(trigger.tableName) || droppedSchemas.has(trigger.schema)) continue;
    const toTrigger = to.triggers[key];
    if (!toTrigger || toTrigger.definition !== trigger.definition) {
      atoms.push(atom({
        id: `drop-trigger:${key}`, kind: "drop_trigger", priority: 0,
        target: trigger.tableName,
        hazards: [hz("HasUntrackableDependencies", `drops trigger ${trigger.name}`)],
        provides: [], requires: [],
        trigger: trigger,
      }));
    }
  }
  for (const [key, trigger] of Object.entries(to.triggers)) {
    const fromTrigger = from.triggers[key];
    if (!fromTrigger || fromTrigger.definition !== trigger.definition) {
      atoms.push(atom({
        id: `create-trigger:${key}`, kind: "create_trigger", priority: 1,
        target: trigger.tableName, hazards: [],
        provides: [], requires: [`table:${trigger.tableName}`],
        trigger: trigger,
      }));
    }
  }
}

// ---------------------------------------------------------------------------
// Dependency resolution
// ---------------------------------------------------------------------------

function resolveEdges(
  atoms: Atom[],
  from: DatabaseSchema,
): Map<string, Set<string>> {
  // Build provides map: capability → atom ID
  const providers = new Map<string, string>();
  for (const atom of atoms) {
    for (const cap of atom.provides) {
      providers.set(cap, atom.id);
    }
  }

  // Pre-existing capabilities from the `from` schema
  const preExisting = new Set<string>();
  for (const key of Object.keys(from.schemas)) preExisting.add(`schema:${key}`);
  preExisting.add("schema:public");
  for (const key of Object.keys(from.extensions)) preExisting.add(`extension:${key}`);
  for (const key of Object.keys(from.enums)) preExisting.add(`enum:${key}`);
  for (const key of Object.keys(from.sequences)) preExisting.add(`sequence:${key}`);
  for (const key of Object.keys(from.tables)) {
    preExisting.add(`table:${key}`);
    const table = from.tables[key];
    for (const col of table.columns) {
      preExisting.add(`column:${key}.${col.name}`);
    }
    for (const con of table.constraints) {
      preExisting.add(`constraint:${key}.${con.name}`);
    }
    if (table.columns) {
      for (const col of table.columns) {
        if (col.sequenceName) preExisting.add(`sequence:${col.sequenceName}`);
      }
    }
  }
  for (const key of Object.keys(from.indexes)) preExisting.add(`index:${key}`);
  for (const [key, fns] of Object.entries(from.functions)) {
    for (const fn of fns) preExisting.add(`function:${key}(${fn.identity})`);
  }
  for (const key of Object.keys(from.views)) preExisting.add(`view:${key}`);

  // Resolve requires → edges
  const edges = new Map<string, Set<string>>();
  for (const atom of atoms) {
    edges.set(atom.id, new Set());
  }
  for (const atom of atoms) {
    for (const req of atom.requires) {
      if (preExisting.has(req)) continue;
      const provider = providers.get(req);
      if (provider && provider !== atom.id) {
        edges.get(atom.id)!.add(provider);
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Topological sort with priority tie-breaking
// ---------------------------------------------------------------------------

function topoSort(atoms: Atom[], edges: Map<string, Set<string>>): Atom[] {
  const atomMap = new Map(atoms.map((a) => [a.id, a]));
  const inDegree = new Map<string, number>();
  const reverseEdges = new Map<string, Set<string>>();

  for (const atom of atoms) {
    inDegree.set(atom.id, 0);
    reverseEdges.set(atom.id, new Set());
  }
  for (const [id, deps] of edges) {
    inDegree.set(id, deps.size);
    for (const dep of deps) {
      reverseEdges.get(dep)?.add(id);
    }
  }

  // Seed with zero in-degree atoms
  const ready: Atom[] = [];
  for (const atom of atoms) {
    if (inDegree.get(atom.id) === 0) ready.push(atom);
  }

  const result: Atom[] = [];
  while (ready.length > 0) {
    // Sort ready set: priority first (lower = earlier), then target name for grouping
    ready.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.target !== b.target) return a.target.localeCompare(b.target);
      return a.order - b.order;
    });

    const atom = ready.shift()!;
    result.push(atom);

    for (const dependent of reverseEdges.get(atom.id) ?? []) {
      const newDeg = inDegree.get(dependent)! - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) {
        ready.push(atomMap.get(dependent)!);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Combine and render
// ---------------------------------------------------------------------------

function combineAndRender(sorted: Atom[]): Statement[] {
  const claimed = new Set<string>();
  const result: Statement[] = [];

  // Tables that already exist (not being created in this diff) are "available"
  const emittedTables = new Set<string>();
  const newTables = new Set<string>();
  for (const atom of sorted) {
    if (atom.kind === "create_table") newTables.add(atom.target);
  }
  for (const atom of sorted) {
    if (atom.target && !newTables.has(atom.target) &&
        (atom.kind === "add_column" || atom.kind === "add_constraint" ||
         atom.kind === "set_not_null" || atom.kind === "set_default" ||
         atom.kind === "drop_column" || atom.kind === "drop_constraint")) {
      emittedTables.add(atom.target);
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    const atom = sorted[i];
    if (claimed.has(atom.id)) continue;

    if (atom.kind === "create_table") {
      const tableKey = atom.target;
      const group = collectTableGroup(sorted, i, tableKey, claimed, emittedTables);
      result.push(...renderCreateTable(atom.table!, group));
      emittedTables.add(tableKey);
    } else if (atom.kind === "alter_enum_values") {
      result.push(...renderEnumModification(atom));
    } else {
      result.push(...renderAtom(atom));
    }
    claimed.add(atom.id);
  }

  return result;
}

interface TableGroup {
  columns: { col: Column; notNull: boolean; defaultExpr: string | null; genExpr: string | null }[];
  constraints: Constraint[];
  indexes: Index[];
  seqCreates: { name: string; opts: SequenceOptions }[];
  seqOwns: { seqName: string; table: string; column: string }[];
  claimed: string[];
}

function collectTableGroup(
  sorted: Atom[], startIdx: number, tableKey: string, claimed: Set<string>,
  emittedTables?: Set<string>,
): TableGroup {
  const group: TableGroup = {
    columns: [], constraints: [], indexes: [],
    seqCreates: [], seqOwns: [], claimed: [],
  };
  const colDefaults = new Map<string, string>();
  const colGenExprs = new Map<string, string>();
  const colNotNulls = new Set<string>();
  const addedColumns: Column[] = [];

  for (let i = startIdx + 1; i < sorted.length; i++) {
    const a = sorted[i];
    if (claimed.has(a.id)) continue;
    if (a.target !== tableKey) continue;

    switch (a.kind) {
      case "add_column":
        addedColumns.push(a.column!);
        group.claimed.push(a.id);
        claimed.add(a.id);
        break;
      case "set_not_null":
        colNotNulls.add(a.columnName!);
        group.claimed.push(a.id);
        claimed.add(a.id);
        break;
      case "set_default":
        colDefaults.set(a.columnName!, a.defaultExpr!);
        group.claimed.push(a.id);
        claimed.add(a.id);
        break;
      case "set_generated":
        colGenExprs.set(a.columnName!, a.genExpr!);
        group.claimed.push(a.id);
        claimed.add(a.id);
        break;
      case "add_constraint": {
        // Only absorb FK constraints if the referenced table already exists
        const con = a.constraint!;
        if (con.type === "FOREIGN KEY" && con.referencedTable &&
            con.referencedTable !== tableKey &&
            !(emittedTables?.has(con.referencedTable))) {
          break; // leave as standalone ALTER TABLE
        }
        group.constraints.push(con);
        group.claimed.push(a.id);
        claimed.add(a.id);
        break;
      }
      case "create_index":
        group.indexes.push(a.index!);
        group.claimed.push(a.id);
        claimed.add(a.id);
        break;
      case "create_sequence":
        group.seqCreates.push({ name: a.seqName!, opts: a.seqOpts! });
        group.claimed.push(a.id);
        claimed.add(a.id);
        break;
      case "own_sequence":
        group.seqOwns.push({ seqName: a.seqName!, table: a.table!, column: a.columnName! });
        group.claimed.push(a.id);
        claimed.add(a.id);
        break;
    }
  }

  for (const col of addedColumns) {
    group.columns.push({
      col,
      notNull: colNotNulls.has(col.name) || !col.isNullable,
      defaultExpr: colDefaults.get(col.name) ?? col.defaultValue,
      genExpr: colGenExprs.get(col.name) ?? col.generationExpression ?? null,
    });
  }

  return group;
}

function renderCreateTable(qt: string, group: TableGroup): Statement[] {
  const stmts: Statement[] = [];

  // Emit sequence creates before the table
  for (const seq of group.seqCreates) {
    stmts.push({ ddl: createSeqDdl(seq.name, seq.opts), hazards: [] });
  }

  // Build CREATE TABLE with inlined columns and constraints
  const parts: string[] = [];
  for (const { col, notNull, defaultExpr, genExpr } of group.columns) {
    let def = `${col.name} ${col.dataType}`;
    if (col.identity) {
      const kind = col.identity.always ? "ALWAYS" : "BY DEFAULT";
      def += ` GENERATED ${kind} AS IDENTITY`;
    } else if (genExpr) {
      def += ` GENERATED ALWAYS AS (${genExpr}) STORED`;
    }
    if (notNull && !col.identity) def += " NOT NULL";
    if (defaultExpr && !col.isGenerated) def += ` DEFAULT ${defaultExpr}`;
    parts.push(def);
  }
  for (const con of group.constraints) {
    parts.push(`CONSTRAINT ${con.name} ${con.definition}`);
  }

  if (parts.length > 0) {
    stmts.push({
      ddl: `CREATE TABLE ${qt} (\n  ${parts.join(",\n  ")}\n)`,
      hazards: [],
    });
  } else {
    stmts.push({ ddl: `CREATE TABLE ${qt} ()`, hazards: [] });
  }

  // Emit sequence owns after table
  for (const own of group.seqOwns) {
    stmts.push({ ddl: `ALTER SEQUENCE ${own.seqName} OWNED BY ${own.table}.${own.column}`, hazards: [] });
  }

  // Emit indexes after table
  for (const idx of group.indexes) {
    stmts.push({ ddl: idx.definition, hazards: [hz("IndexBuild", `builds index ${idx.schema}.${idx.name}`)] });
  }

  return stmts;
}

function renderEnumModification(atom: Atom): Statement[] {
  const stmts: Statement[] = [];
  const qName = `${atom.enumTo!.schema}.${atom.enumTo!.name}`;
  const oldName = `${atom.enumTo!.schema}.${atom.enumTo!.name}__old`;

  stmts.push({ ddl: `ALTER TYPE ${qName} RENAME TO ${atom.enumTo!.name}__old`, hazards: [] });

  const vals = atom.enumTo!.values.map(escapeLiteral).join(", ");
  stmts.push({ ddl: `CREATE TYPE ${qName} AS ENUM (${vals})`, hazards: [] });

  for (const ac of atom.affectedCols ?? []) {
    if (ac.isArray) {
      stmts.push({
        ddl: `ALTER TABLE ${ac.table} ALTER COLUMN ${ac.col} TYPE ${qName}[] USING ${ac.col}::text[]::${qName}[]`,
        hazards: [hz("AcquiresAccessExclusiveLock", `rewrites column ${ac.col} to new enum array type`)],
      });
    } else {
      stmts.push({
        ddl: `ALTER TABLE ${ac.table} ALTER COLUMN ${ac.col} TYPE ${qName} USING ${ac.col}::text::${qName}`,
        hazards: [hz("AcquiresAccessExclusiveLock", `rewrites column ${ac.col} to new enum type`)],
      });
    }
  }

  stmts.push({ ddl: `DROP TYPE ${oldName}`, hazards: [] });
  return stmts;
}

function renderAtom(atom: Atom): Statement[] {
  switch (atom.kind) {
    case "create_schema":
      return [{ ddl: `CREATE SCHEMA ${atom.schemaName}`, hazards: atom.hazards }];
    case "drop_schema":
      return [{ ddl: `DROP SCHEMA ${atom.schemaName} CASCADE`, hazards: atom.hazards }];
    case "create_extension":
      return [{
        ddl: `CREATE EXTENSION IF NOT EXISTS ${escapeExtName(atom.extName!)}` +
          (atom.extSchema && atom.extSchema !== "public" ? ` SCHEMA ${atom.extSchema}` : ""),
        hazards: atom.hazards,
      }];
    case "drop_extension":
      return [{ ddl: `DROP EXTENSION ${escapeExtName(atom.extName!)}`, hazards: atom.hazards }];
    case "alter_extension":
      return [{
        ddl: `ALTER EXTENSION ${escapeExtName(atom.extName!)} UPDATE TO ${escapeLiteral(atom.extVersion!)}`,
        hazards: atom.hazards,
      }];
    case "create_enum":
      return [{
        ddl: `CREATE TYPE ${atom.enumTo!.schema}.${atom.enumTo!.name} AS ENUM (${atom.enumTo!.values.map(escapeLiteral).join(", ")})`,
        hazards: atom.hazards,
      }];
    case "drop_enum":
      return [{ ddl: `DROP TYPE ${atom.schemaName}.${atom.columnName}`, hazards: atom.hazards }];
    case "create_sequence":
      return [{ ddl: createSeqDdl(atom.seqName!, atom.seqOpts!), hazards: atom.hazards }];
    case "drop_sequence":
      return [{ ddl: `DROP SEQUENCE ${atom.seqName}`, hazards: atom.hazards }];
    case "alter_sequence": {
      const parts: string[] = [];
      const f = atom.seqOptsFrom!, t = atom.seqOpts!;
      if (f.dataType !== t.dataType) parts.push(`AS ${t.dataType}`);
      if (f.startValue !== t.startValue) parts.push(`START WITH ${t.startValue}`);
      if (f.increment !== t.increment) parts.push(`INCREMENT BY ${t.increment}`);
      if (f.minValue !== t.minValue) parts.push(`MINVALUE ${t.minValue}`);
      if (f.maxValue !== t.maxValue) parts.push(`MAXVALUE ${t.maxValue}`);
      if (f.cacheSize !== t.cacheSize) parts.push(`CACHE ${t.cacheSize}`);
      if (f.cycle !== t.cycle) parts.push(t.cycle ? "CYCLE" : "NO CYCLE");
      if (parts.length === 0) return [];
      return [{ ddl: `ALTER SEQUENCE ${atom.seqName} ${parts.join(" ")}`, hazards: atom.hazards }];
    }
    case "create_function":
      return [{ ddl: atom.functionDef!.definition, hazards: atom.hazards }];
    case "drop_function":
      return [{ ddl: `DROP FUNCTION ${atom.table}${atom.fnIdentity}`, hazards: atom.hazards }];
    case "create_table":
      // Standalone (no combining happened) — shouldn't normally reach here
      return [{ ddl: `CREATE TABLE ${atom.table} ()`, hazards: atom.hazards }];
    case "drop_table":
      return [{ ddl: `DROP TABLE ${atom.table}`, hazards: atom.hazards }];
    case "add_column": {
      let def = `${atom.column!.name} ${atom.column!.dataType}`;
      if (atom.column!.identity) {
        const kind = atom.column!.identity.always ? "ALWAYS" : "BY DEFAULT";
        def += ` GENERATED ${kind} AS IDENTITY`;
      }
      if (atom.column!.isGenerated && atom.column!.generationExpression) {
        def += ` GENERATED ALWAYS AS (${atom.column!.generationExpression}) STORED`;
      }
      const hazards = [...atom.hazards];
      if (!atom.column!.isNullable && atom.column!.defaultValue === null &&
          !atom.column!.isGenerated && !atom.column!.identity) {
        hazards.push(hz("Correctness", `will fail if table ${atom.table} has existing rows`));
      }
      return [{ ddl: `ALTER TABLE ${atom.table} ADD COLUMN ${def}`, hazards }];
    }
    case "drop_column":
      return [{ ddl: `ALTER TABLE ${atom.table} DROP COLUMN ${atom.columnName}`, hazards: atom.hazards }];
    case "alter_column_type":
      return [{ ddl: `ALTER TABLE ${atom.table} ALTER COLUMN ${atom.columnName} TYPE ${atom.newType}`, hazards: atom.hazards }];
    case "set_not_null":
      return [{ ddl: `ALTER TABLE ${atom.table} ALTER COLUMN ${atom.columnName} SET NOT NULL`, hazards: atom.hazards }];
    case "drop_not_null":
      return [{ ddl: `ALTER TABLE ${atom.table} ALTER COLUMN ${atom.columnName} DROP NOT NULL`, hazards: atom.hazards }];
    case "set_default":
      return [{ ddl: `ALTER TABLE ${atom.table} ALTER COLUMN ${atom.columnName} SET DEFAULT ${atom.defaultExpr}`, hazards: atom.hazards }];
    case "drop_default":
      return [{ ddl: `ALTER TABLE ${atom.table} ALTER COLUMN ${atom.columnName} DROP DEFAULT`, hazards: atom.hazards }];
    case "set_generated":
      return [{ ddl: `ALTER TABLE ${atom.table} ALTER COLUMN ${atom.columnName} SET EXPRESSION AS (${atom.genExpr})`, hazards: atom.hazards }];
    case "alter_identity":
      return [{ ddl: `ALTER TABLE ${atom.table} ALTER COLUMN ${atom.columnName} SET GENERATED ${atom.newType}`, hazards: atom.hazards }];
    case "add_constraint":
      return [{ ddl: `ALTER TABLE ${atom.table} ADD CONSTRAINT ${atom.constraint!.name} ${atom.constraint!.definition}`, hazards: atom.hazards }];
    case "drop_constraint":
      return [{ ddl: `ALTER TABLE ${atom.table} DROP CONSTRAINT ${atom.columnName}`, hazards: atom.hazards }];
    case "create_index":
      return [{ ddl: atom.index!.definition, hazards: atom.hazards }];
    case "drop_index":
      return [{ ddl: `DROP INDEX ${atom.index!.schema}.${atom.index!.name}`, hazards: atom.hazards }];
    case "create_view":
      return [{ ddl: `CREATE VIEW ${atom.view!.schema}.${atom.view!.name} AS ${atom.view!.definition}`, hazards: atom.hazards }];
    case "drop_view":
      return [{ ddl: `DROP VIEW ${atom.view!.schema}.${atom.view!.name}`, hazards: atom.hazards }];
    case "create_trigger":
      return [{ ddl: atom.trigger!.definition, hazards: atom.hazards }];
    case "drop_trigger":
      return [{ ddl: `DROP TRIGGER ${atom.trigger!.name} ON ${atom.trigger!.tableName}`, hazards: atom.hazards }];
    case "own_sequence":
      return [{ ddl: `ALTER SEQUENCE ${atom.seqName} OWNED BY ${atom.table}.${atom.columnName}`, hazards: atom.hazards }];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function seqOptsEq(a: SequenceOptions, b: SequenceOptions): boolean {
  return a.dataType === b.dataType && a.startValue === b.startValue &&
    a.minValue === b.minValue && a.maxValue === b.maxValue &&
    a.increment === b.increment && a.cacheSize === b.cacheSize &&
    a.cycle === b.cycle;
}

function createSeqDdl(name: string, opts: SequenceOptions): string {
  return `CREATE SEQUENCE ${name} AS ${opts.dataType} START WITH ${opts.startValue} INCREMENT BY ${opts.increment} MINVALUE ${opts.minValue} MAXVALUE ${opts.maxValue} CACHE ${opts.cacheSize}${opts.cycle ? " CYCLE" : " NO CYCLE"}`;
}

function genState(col: Column): string {
  if (col.identity) return col.identity.always ? "identity-always" : "identity-default";
  if (col.isGenerated) return "stored";
  return "none";
}

function allImplicitSeqs(schema: DatabaseSchema): Set<string> {
  const seqs = new Set<string>();
  for (const table of Object.values(schema.tables)) {
    for (const col of table.columns) {
      if (col.sequenceName) seqs.add(col.sequenceName);
    }
  }
  return seqs;
}

function escapeExtName(name: string): string {
  if (/^[a-z_][a-z0-9_]*$/.test(name)) return name;
  return `"${name.replace(/"/g, '""')}"`;
}
