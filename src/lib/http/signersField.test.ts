import { describe, expect, test } from "bun:test";

import { parseSignersField } from "./signersField.ts";

describe("parseSignersField", () => {
  const ada = { name: "Ada", email: "ada@example.com" };

  test("reads the JSON string a client sends", () => {
    expect(parseSignersField(JSON.stringify([ada]))).toEqual([
      { name: "Ada", email: "ada@example.com", accessCode: undefined },
    ]);
  });

  test("reads the array Elysia hands over after parsing a multipart field", () => {
    expect(parseSignersField([ada])).toEqual([
      { name: "Ada", email: "ada@example.com", accessCode: undefined },
    ]);
  });

  test("trims values and drops entries without a name", () => {
    expect(
      parseSignersField([
        { name: "  Grace ", email: " g@example.com ", accessCode: " 1234 " },
        { name: "   ", email: "x@example.com" },
        { email: "nobody@example.com" },
      ]),
    ).toEqual([{ name: "Grace", email: "g@example.com", accessCode: "1234" }]);
  });

  test("never throws on malformed input", () => {
    expect(parseSignersField("not json")).toEqual([]);
    expect(parseSignersField(undefined)).toEqual([]);
    expect(parseSignersField({ name: "not an array" })).toEqual([]);
    expect(parseSignersField([null, 7, "x", { name: 42 }])).toEqual([]);
  });
});
