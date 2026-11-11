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

  test("does not detect prose that merely mentions sign/date/initials", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    // a legal document says these words constantly; none are fillable spots
    for (const [i, line] of [
      "effective as of the date the last Member signs this Agreement,",
      "and the relationship among the Members from the date written",
      "each Member's spouse shall sign a Spousal Acknowledgment, and",
      "a failure or refusal to sign is not a breach of this Agreement.",
    ].entries()) {
      page.drawText(line, { x: 72, y: 700 - i * 20, size: 11, font });
    }
    expect(await detectFields(await doc.save())).toHaveLength(0);
  });

  test("detects both blanks in a signature-and-date line in one run", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    // the common member-signature block shape: one run, two blanks
    page.drawText(
      "________________________________________ Date: ______________",
      { x: 72, y: 200, size: 12, font },
    );
    const fields = await detectFields(await doc.save());
    const signature = fields.find((f) => f.type === "signature");
    const date = fields.find((f) => f.type === "date");
    expect(signature).toBeDefined();
    expect(date).toBeDefined();
    // the date field sits to the right of the signature line
    expect((date as DetectedField).x).toBeGreaterThan(
      (signature as DetectedField).x,
    );
  });

  test("treats a long underscore signing line as a signature, not the trailing label", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    // common signature-block shape: sign on the long line, "Date" labels a field
    page.drawText("________________________________________ Date", {
      x: 72,
      y: 200,
      size: 12,
      font,
    });
    const fields = await detectFields(await doc.save());
    expect(fields).toHaveLength(1);
    expect(fields[0]?.type).toBe("signature");
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
      {
        type: "signature",
        page: 1,
        x: 130,
        y: 200,
        width: 150,
        height: 12,
        value: "Ada Lovelace",
      },
      {
        type: "date",
        page: 1,
        x: 110,
        y: 170,
        width: 100,
        height: 12,
        value: "2026-11-09",
      },
    ];
    const stamped = await stampFields(pdf, fields);
    expect(stamped.length).toBeGreaterThan(pdf.length);
    const text = await extractText(stamped);
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("2026-11-09");
  });

  test("is a no-op when there are no fields", async () => {
    const pdf = await anchorPdf();
    const out = await stampFields(pdf, []);
    expect(out).toBe(pdf);
  });

  test("draws a mark for a ticked checkbox", async () => {
    const pdf = await anchorPdf();
    const stamped = await stampFields(pdf, [
      {
        type: "checkbox",
        page: 1,
        x: 100,
        y: 200,
        width: 14,
        height: 14,
        value: "true",
      },
    ]);
    // a ticked box re-serializes the PDF with the drawn check mark
    expect(stamped).not.toBe(pdf);
    expect(stamped.length).toBeGreaterThan(0);
  });

  test("skips an unticked checkbox", async () => {
    const pdf = await anchorPdf();
    const stamped = await stampFields(pdf, [
      {
        type: "checkbox",
        page: 1,
        x: 100,
        y: 200,
        width: 14,
        height: 14,
        value: "",
      },
    ]);
    // no value means nothing to draw, so the original PDF is returned unchanged
    expect(stamped).toBe(pdf);
  });

  test("draws a radio button with its label, filled when chosen", async () => {
    const pdf = await anchorPdf();
    const stamped = await stampFields(pdf, [
      {
        type: "radio",
        page: 1,
        x: 120,
        y: 200,
        width: 120,
        height: 14,
        value: "selected",
        options: ["Agree"],
      },
    ]);
    expect(stamped).not.toBe(pdf);
    const text = await extractText(stamped);
    expect(text).toContain("Agree");
  });

  test("draws an unchosen radio button (empty circle) too", async () => {
    const pdf = await anchorPdf();
    const stamped = await stampFields(pdf, [
      {
        type: "radio",
        page: 1,
        x: 120,
        y: 200,
        width: 120,
        height: 14,
        value: "",
        options: ["Decline"],
      },
    ]);
    // a radio always draws its circle even when not chosen
    expect(stamped).not.toBe(pdf);
  });

  test("draws the chosen option for a dropdown field", async () => {
    const pdf = await anchorPdf();
    const stamped = await stampFields(pdf, [
      {
        type: "dropdown",
        page: 1,
        x: 120,
        y: 200,
        width: 140,
        height: 16,
        value: "Net 30",
      },
    ]);
    const text = await extractText(stamped);
    expect(text).toContain("Net 30");
  });
});

describe("initials", () => {
  test("takes the first letter of each word", () => {
    expect(initialsOf("Ada Lovelace")).toBe("AL");
    expect(initialsOf("  grace   hopper ")).toBe("GH");
    expect(initialsOf("Cher")).toBe("C");
  });
});
