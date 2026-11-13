import { describe, expect, test } from "bun:test";

import { DEFAULT_INK, hexToInk } from "./stamp.ts";

describe("hexToInk", () => {
  test("parses #rrggbb into a 0..1 rgb ink", () => {
    const ink = hexToInk("#ff8000");
    expect(ink).not.toBeNull();
    expect(ink?.red).toBeCloseTo(1, 5);
    expect(ink?.green).toBeCloseTo(128 / 255, 5);
    expect(ink?.blue).toBeCloseTo(0, 5);
  });

  test("accepts a hex without the leading hash and ignores surrounding space", () => {
    expect(hexToInk("  000000 ")?.red).toBeCloseTo(0, 5);
  });

  test("returns null for an absent or malformed color so the caller uses the default", () => {
    expect(hexToInk(null)).toBeNull();
    expect(hexToInk(undefined)).toBeNull();
    expect(hexToInk("")).toBeNull();
    expect(hexToInk("#fff")).toBeNull();
    expect(hexToInk("not-a-color")).toBeNull();
  });

  test("the default ink is the established signing blue", () => {
    expect(DEFAULT_INK.red).toBeCloseTo(0.11, 5);
    expect(DEFAULT_INK.green).toBeCloseTo(0.18, 5);
    expect(DEFAULT_INK.blue).toBeCloseTo(0.45, 5);
  });
});
