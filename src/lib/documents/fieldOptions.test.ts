import { describe, expect, test } from "bun:test";

import { parseFieldOptions } from "./documentService.ts";

describe("parseFieldOptions", () => {
  test("parses a stored JSON array of choices", () => {
    expect(parseFieldOptions('["Net 30","Net 60","Due on receipt"]')).toEqual([
      "Net 30",
      "Net 60",
      "Due on receipt",
    ]);
  });

  test("returns null for a null column", () => {
    expect(parseFieldOptions(null)).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    expect(parseFieldOptions("not json")).toBeNull();
  });

  test("returns null when the JSON is not an array", () => {
    expect(parseFieldOptions('{"a":1}')).toBeNull();
  });

  test("keeps only string entries", () => {
    expect(parseFieldOptions('["ok", 2, null, "fine"]')).toEqual([
      "ok",
      "fine",
    ]);
  });
});
