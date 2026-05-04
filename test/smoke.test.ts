import { PGlite } from "@electric-sql/pglite";
import { describe, it, expect } from "vitest";

describe("PGlite smoke test", () => {
  it("instantiates and runs a query", async () => {
    const db = new PGlite();
    const result = await db.query<{ v: number }>("SELECT 1 AS v");
    expect(result.rows).toEqual([{ v: 1 }]);
    await db.close();
  });
});
