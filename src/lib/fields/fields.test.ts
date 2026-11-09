import { describe, expect, test } from "bun:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { DetectedField } from "./detect.ts";
import { detectFields, extractText } from "./detect.ts";
import { initialsOf, stampFields } from "./stamp.ts";

/** Build a one-page PDF carrying signature and date anchors */
const anchorPdf = async (): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("MUTUAL NON-DISCLOSURE AGREEMENT", {
    x: 72,
    y: 720,
    size: 16,
    font,
  });
  page.drawText("Signature: ______________________", {
    x: 72,
    y: 200,
    size: 12,
    font,
  });
  page.drawText("Date: ______________", { x: 72, y: 170, size: 12, font });
  return doc.save();
};

describe("field detection", () => {
  test("detects a signature and a date anchor with positions", async () => {
    const fields = await detectFields(await anchorPdf());
    const signature = fields.find((f) => f.type === "signature");
    const date = fields.find((f) => f.type === "date");
    expect(signature).toBeDefined();
    expect(date).toBeDefined();
    expect(signature?.page).toBe(1);
    // the signature field sits on the underscore run, to the right of the label
    expect((signature as DetectedField).x).toBeGreaterThan(72);
    expect((signature as DetectedField).y).toBeCloseTo(200, 0);
  });

  test("returns no fields for a document with no anchors", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText("Just some prose with no fillable spots.", {
      x: 72,
      y: 700,
      size: 12,
      font,
    });
    expect(await detectFields(await doc.save())).toHaveLength(0);
  });

  test("tolerates a non-PDF without throwing", async () => {
    expect(await detectFields(new Uint8Array([1, 2, 3]))).toEqual([]);
  });

  test("still detects after a malformed input (worker stays healthy)", async () => {
    await detectFields(new Uint8Array([1, 2, 3]));
    const fields = await detectFields(await anchorPdf());
    expect(fields.some((f) => f.type === "signature")).toBe(true);
  });
});

describe("field stamping", () => {
  test("stamps the adopted signature and date into the document text", async () => {
    const pdf = await anchorPdf();
    // manual fields keep this assertion independent of PDF parsing
    const fields = [
      { type: "signature", page: 1, x: 130, y: 200, width: 150, height: 12 },
      { type: "date", page: 1, x: 110, y: 170, width: 100, height: 12 },
    ];
    const stamped = await stampFields(pdf, fields, {
      signature: "Ada Lovelace",
      date: "2026-11-09",
    });
    expect(stamped.length).toBeGreaterThan(pdf.length);
    const text = await extractText(stamped);
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("2026-11-09");
  });

  test("is a no-op when there are no fields", async () => {
    const pdf = await anchorPdf();
    const out = await stampFields(pdf, [], {
      signature: "x",
      date: "y",
    });
    expect(out).toBe(pdf);
  });
});

describe("initials", () => {
  test("takes the first letter of each word", () => {
    expect(initialsOf("Ada Lovelace")).toBe("AL");
    expect(initialsOf("  grace   hopper ")).toBe("GH");
    expect(initialsOf("Cher")).toBe("C");
  });
});
