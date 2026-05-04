import { PGlite } from "@electric-sql/pglite";
import { extractSchema } from "./extract.js";
import { generateDdl } from "./generate.js";
import { splitSql } from "./split-sql.js";
import type {
  Column,
  Constraint,
  DatabaseSchema,
  Queryable,
  ValidationError,
} from "./types.js";

export async function validateDiff(
  from: DatabaseSchema,
  to: DatabaseSchema,
  ddl: string,
  existingDb?: PGlite,
): Promise<ValidationError[]> {
  const ownDb = !existingDb;
  const db = existingDb ?? new PGlite();

  try {
    if (!existingDb) {
      const setupDdl = generateDdl(from);
      for (const stmt of splitSql(setupDdl)) {
        await db.query(stmt);
      }
    }

    for (const stmt of splitSql(ddl)) {
      await db.query(stmt);
    }

    const actual = await extractSchema(db as Queryable);
    return compareSchemas(actual, to);
  } finally {
    if (ownDb) {
      await db.close();
    }
  }
}

export function compareSchemas(
  actual: DatabaseSchema,
  expected: DatabaseSchema,
): ValidationError[] {
  const errors: ValidationError[] = [];

  compareRecords("schemas", actual.schemas, expected.schemas, errors, (a, e, path) => {
    compareField(path, "name", a.name, e.name, errors);
  });

  compareRecords("extensions", actual.extensions, expected.extensions, errors, (a, e, path) => {
    compareField(path, "name", a.name, e.name, errors);
    compareField(path, "version", a.version, e.version, errors);
  });

  compareRecords("enums", actual.enums, expected.enums, errors, (a, e, path) => {
    compareField(path, "values", JSON.stringify(a.values), JSON.stringify(e.values), errors);
  });

  compareRecords("sequences", actual.sequences, expected.sequences, errors, (a, e, path) => {
    compareField(path, "dataType", a.dataType, e.dataType, errors);
    compareField(path, "startValue", a.startValue, e.startValue, errors);
    compareField(path, "increment", a.increment, e.increment, errors);
    compareField(path, "minValue", a.minValue, e.minValue, errors);
    compareField(path, "maxValue", a.maxValue, e.maxValue, errors);
    compareField(path, "cacheSize", a.cacheSize, e.cacheSize, errors);
    compareField(path, "cycle", a.cycle, e.cycle, errors);
  });

  compareRecords("tables", actual.tables, expected.tables, errors, (a, e, path) => {
    compareTables(a, e, path, errors);
  });

  compareRecords("indexes", actual.indexes, expected.indexes, errors, (a, e, path) => {
    compareField(path, "definition", a.definition, e.definition, errors);
  });

  compareRecords("views", actual.views, expected.views, errors, (a, e, path) => {
    compareField(path, "definition", a.definition, e.definition, errors);
  });

  compareRecords("functions", actual.functions, expected.functions, errors, (a, e, path) => {
    if (a.length !== e.length) {
      errors.push({
        path: `${path}.overloads`,
        expected: e.length,
        actual: a.length,
        message: `expected ${e.length} overloads, got ${a.length}`,
      });
    } else {
      const aByIdentity = new Map(a.map((f) => [f.identity, f]));
      for (const ef of e) {
        const af = aByIdentity.get(ef.identity);
        if (!af) {
          errors.push({
            path: `${path}(${ef.identity})`,
            expected: ef.identity,
            actual: undefined,
            message: `missing overload with identity ${ef.identity}`,
          });
        } else {
          compareField(`${path}(${ef.identity})`, "definition", af.definition, ef.definition, errors);
        }
      }
    }
  });

  compareRecords("triggers", actual.triggers, expected.triggers, errors, (a, e, path) => {
    compareField(path, "definition", a.definition, e.definition, errors);
  });

  return errors;
}

function compareTables(
  actual: { columns: Column[]; constraints: Constraint[] },
  expected: { columns: Column[]; constraints: Constraint[] },
  path: string,
  errors: ValidationError[],
) {
  // Compare columns by name
  const actualCols = new Map(actual.columns.map((c) => [c.name, c]));
  const expectedCols = new Map(expected.columns.map((c) => [c.name, c]));

  for (const [name, ec] of expectedCols) {
    const ac = actualCols.get(name);
    if (!ac) {
      errors.push({
        path: `${path}.columns.${name}`,
        expected: name,
        actual: undefined,
        message: `missing column ${name}`,
      });
      continue;
    }
    const cp = `${path}.columns.${name}`;
    compareField(cp, "dataType", ac.dataType, ec.dataType, errors);
    compareField(cp, "isNullable", ac.isNullable, ec.isNullable, errors);
    compareField(cp, "defaultValue", ac.defaultValue, ec.defaultValue, errors);
    compareField(cp, "isGenerated", ac.isGenerated, ec.isGenerated, errors);
    compareField(cp, "generationExpression", ac.generationExpression, ec.generationExpression, errors);
    if (ec.identity) {
      if (!ac.identity) {
        errors.push({ path: `${cp}.identity`, expected: "identity", actual: null, message: "expected identity column" });
      } else {
        compareField(cp, "identity.always", ac.identity.always, ec.identity.always, errors);
      }
    } else if (ac.identity) {
      errors.push({ path: `${cp}.identity`, expected: null, actual: "identity", message: "unexpected identity column" });
    }
  }
  for (const [name] of actualCols) {
    if (!expectedCols.has(name)) {
      errors.push({
        path: `${path}.columns.${name}`,
        expected: undefined,
        actual: name,
        message: `unexpected column ${name}`,
      });
    }
  }

  // Compare constraints by name
  const actualCons = new Map(actual.constraints.map((c) => [c.name, c]));
  const expectedCons = new Map(expected.constraints.map((c) => [c.name, c]));

  for (const [name, ec] of expectedCons) {
    const ac = actualCons.get(name);
    if (!ac) {
      errors.push({
        path: `${path}.constraints.${name}`,
        expected: name,
        actual: undefined,
        message: `missing constraint ${name}`,
      });
      continue;
    }
    compareField(`${path}.constraints.${name}`, "definition", ac.definition, ec.definition, errors);
  }
  for (const [name] of actualCons) {
    if (!expectedCons.has(name)) {
      errors.push({
        path: `${path}.constraints.${name}`,
        expected: undefined,
        actual: name,
        message: `unexpected constraint ${name}`,
      });
    }
  }
}

function compareRecords<T>(
  name: string,
  actual: Record<string, T>,
  expected: Record<string, T>,
  errors: ValidationError[],
  compare: (a: T, e: T, path: string) => void,
) {
  for (const [key, ev] of Object.entries(expected)) {
    const av = actual[key];
    if (av === undefined) {
      errors.push({
        path: `${name}.${key}`,
        expected: key,
        actual: undefined,
        message: `missing ${name} ${key}`,
      });
    } else {
      compare(av, ev, `${name}.${key}`);
    }
  }
  for (const key of Object.keys(actual)) {
    if (!(key in expected)) {
      errors.push({
        path: `${name}.${key}`,
        expected: undefined,
        actual: key,
        message: `unexpected ${name} ${key}`,
      });
    }
  }
}

function compareField(
  path: string,
  field: string,
  actual: unknown,
  expected: unknown,
  errors: ValidationError[],
) {
  if (actual !== expected) {
    errors.push({
      path: `${path}.${field}`,
      expected,
      actual,
      message: `${path}.${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    });
  }
}
