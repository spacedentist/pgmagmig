import { describe, it, expect } from "vitest";
import { escapeLiteral, escapeIdentifier } from "../src/escape.js";

describe("escapeLiteral", () => {
  it("wraps a simple string in single quotes", () => {
    expect(escapeLiteral("hello")).toBe("'hello'");
  });

  it("escapes embedded single quotes", () => {
    expect(escapeLiteral("it's")).toBe("'it''s'");
  });

  it("uses E-string syntax for backslashes", () => {
    expect(escapeLiteral("back\\slash")).toBe(" E'back\\\\slash'");
  });

  it("handles empty string", () => {
    expect(escapeLiteral("")).toBe("''");
  });
});

describe("escapeIdentifier", () => {
  it("wraps in double quotes", () => {
    expect(escapeIdentifier("users")).toBe('"users"');
  });

  it("escapes embedded double quotes", () => {
    expect(escapeIdentifier('My "Table"')).toBe('"My ""Table"""');
  });

  it("handles identifiers with spaces", () => {
    expect(escapeIdentifier("my table")).toBe('"my table"');
  });
});
