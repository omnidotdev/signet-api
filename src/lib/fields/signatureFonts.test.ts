import { describe, expect, test } from "bun:test";

import { PDFDict, PDFDocument, PDFName } from "pdf-lib";

import {
  CLASSIC_X_HEIGHT_EM,
  handwritingSize,
  isSignatureFont,
  loadSignatureFont,
  SIGNATURE_FONTS,
  signatureFontOrNull,
  signatureFontXHeight,
} from "./signatureFonts.ts";
import { stampFields } from "./stamp.ts";

const blankPdf = async (): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
};

/**
 * The BaseFont names of every font dictionary in a PDF. Parsed from the object
 * graph, since pdf-lib packs dictionaries into compressed object streams where
 * a raw-bytes search cannot see them
 */
const embeddedFontNames = async (pdf: Uint8Array): Promise<string[]> => {
  const doc = await PDFDocument.load(pdf);
  const names: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const base = obj.get(PDFName.of("BaseFont"));
    if (base instanceof PDFName) names.push(base.asString());
  }
  return names;
};

describe("signature font registry", () => {
  test("classic is the default and every handwriting style is known", () => {
    expect(SIGNATURE_FONTS[0]).toBe("classic");
    for (const id of SIGNATURE_FONTS) expect(isSignatureFont(id)).toBe(true);
    expect(isSignatureFont("comic-sans")).toBe(false);
    expect(isSignatureFont(null)).toBe(false);
  });

  test("an unknown or absent choice normalizes to null (the classic style)", () => {
    expect(signatureFontOrNull("sacramento")).toBe("sacramento");
    expect(signatureFontOrNull("classic")).toBeNull();
    expect(signatureFontOrNull("../../etc/passwd")).toBeNull();
    expect(signatureFontOrNull(undefined)).toBeNull();
  });

  test("each handwriting style loads real TrueType bytes", async () => {
    for (const id of SIGNATURE_FONTS) {
      if (id === "classic") continue;
      const bytes = await loadSignatureFont(id);
      expect(bytes).not.toBeNull();
      // TrueType files start with the 0x00010000 sfnt version
      expect([...(bytes as Uint8Array).slice(0, 4)]).toEqual([0, 1, 0, 0]);
    }
    expect(await loadSignatureFont("classic")).toBeNull();
  });
});

describe("stamping a typed signature in a handwriting style", () => {
  const sigField = {
    type: "signature",
    page: 1,
    x: 72,
    y: 100,
    width: 200,
    height: 40,
    value: "Ada Lovelace",
  };

  test("embeds the chosen handwriting font", async () => {
    const pdf = await stampFields(await blankPdf(), [
      { ...sigField, font: "sacramento" },
    ]);
    const fonts = await embeddedFontNames(pdf);
    expect(fonts.some((f) => f.includes("Sacramento"))).toBe(true);
    expect(fonts.some((f) => f.includes("Helvetica-Oblique"))).toBe(false);
  });

  test("keeps the classic oblique face when no style is chosen", async () => {
    const pdf = await stampFields(await blankPdf(), [sigField]);
    expect(
      (await embeddedFontNames(pdf)).some((f) => f.includes("Oblique")),
    ).toBe(true);
  });

  test("never applies a handwriting font to plain text or date fields", async () => {
    const pdf = await stampFields(await blankPdf(), [
      { ...sigField, type: "text", value: "Acme Corp", font: "sacramento" },
    ]);
    expect(
      (await embeddedFontNames(pdf)).some((f) => f.includes("Sacramento")),
    ).toBe(false);
  });
});

describe("handwriting optical size", () => {
  test("each face is scaled so its lowercase letters match the classic signature", async () => {
    for (const id of SIGNATURE_FONTS) {
      if (id === "classic") continue;
      const xHeightEm = await signatureFontXHeight(id);
      expect(xHeightEm).not.toBeNull();
      const size = handwritingSize(12, xHeightEm as number);
      // the face's x-height at its size equals Helvetica Oblique's at 12pt
      expect(size * (xHeightEm as number)).toBeCloseTo(
        12 * CLASSIC_X_HEIGHT_EM,
        5,
      );
    }
  });

  test("thin flowing faces draw larger than the classic size, a big-bodied face does not", async () => {
    const sacramento = handwritingSize(
      12,
      (await signatureFontXHeight("sacramento")) as number,
    );
    const homemade = handwritingSize(
      12,
      (await signatureFontXHeight("homemade")) as number,
    );
    expect(sacramento).toBeGreaterThan(18);
    expect(homemade).toBeLessThan(12);
  });

  test("classic and unknown styles have no handwriting metrics", async () => {
    expect(await signatureFontXHeight("classic")).toBeNull();
    expect(await signatureFontXHeight("nope")).toBeNull();
  });
});
