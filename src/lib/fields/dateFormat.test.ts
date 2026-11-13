import { describe, expect, test } from "bun:test";

import { DATE_FORMATS, formatDate, isDateFormat } from "./dateFormat.ts";

describe("formatDate", () => {
  const iso = "2026-11-02";

  test("iso and an absent format keep the plain ISO date", () => {
    expect(formatDate(iso, "iso")).toBe("2026-11-02");
    expect(formatDate(iso, null)).toBe("2026-11-02");
    expect(formatDate(iso, undefined)).toBe("2026-11-02");
  });

  test("us renders month/day/year", () => {
    expect(formatDate(iso, "us")).toBe("11/02/2026");
  });

  test("eu renders day/month/year", () => {
    expect(formatDate(iso, "eu")).toBe("02/11/2026");
  });

  test("long spells the month with no leading zero on the day", () => {
    expect(formatDate(iso, "long")).toBe("November 2, 2026");
  });

  test("a non-ISO value is returned unchanged, whatever the format", () => {
    expect(formatDate("received on delivery", "us")).toBe(
      "received on delivery",
    );
    expect(formatDate("", "long")).toBe("");
  });

  test("an impossible date is not reformatted", () => {
    expect(formatDate("2026-13-40", "us")).toBe("2026-13-40");
  });

  test("an unknown format falls back to ISO", () => {
    expect(formatDate(iso, "klingon")).toBe("2026-11-02");
  });
});

describe("isDateFormat", () => {
  test("accepts the known formats and rejects anything else", () => {
    for (const f of DATE_FORMATS) expect(isDateFormat(f)).toBe(true);
    expect(isDateFormat("klingon")).toBe(false);
    expect(isDateFormat(null)).toBe(false);
    expect(isDateFormat(7)).toBe(false);
  });
});
