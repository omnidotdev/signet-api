import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { PDFDocument, StandardFonts } from "pdf-lib";

import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { field, signer } from "../db/schema.ts";
import { createMultiSignerRequest } from "./documentService.ts";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

/** Draw a "Signature:" and "Date:" line pair at each given position */
const pdfWithBlocks = async (
  blocks: { x: number; y: number }[],
): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const { x, y } of blocks) {
    page.drawText("Signature: ______________________", {
      x,
      y,
      size: 12,
      font,
    });
    page.drawText("Date: ______________", { x, y: y - 25, size: 12, font });
  }
  return doc.save();
};

/** Each signer's field types, by signer name */
const fieldsBySigner = async (documentId: string) => {
  const signers = await db
    .select()
    .from(signer)
    .where(eq(signer.documentId, documentId));
  const fields = await db
    .select()
    .from(field)
    .where(eq(field.documentId, documentId));
  const nameOf = new Map(signers.map((s) => [s.id, s.name]));
  const out: Record<string, { type: string; x: number }[]> = {};
  for (const f of fields) {
    const name = nameOf.get(f.signerId ?? "") ?? "unassigned";
    const list = out[name] ?? [];
    list.push({ type: f.type, x: f.x });
    out[name] = list;
  }
  return out;
};

describe("auto-assigning detected fields across signers", () => {
  test("side-by-side blocks: each party gets the date under their own signature", async () => {
    const req = await createMultiSignerRequest(db, {
      name: "Two-party agreement",
      pdf: await pdfWithBlocks([
        { x: 72, y: 260 },
        { x: 330, y: 260 },
      ]),
      signers: [{ name: "Left" }, { name: "Right" }],
    });
    const by = await fieldsBySigner(req.id);
    const types = (n: string) => (by[n] ?? []).map((f) => f.type).sort();
    expect(types("Left")).toEqual(["date", "signature"]);
    expect(types("Right")).toEqual(["date", "signature"]);
    // and the left party's fields are the left column
    expect((by.Left ?? []).every((f) => f.x < 300)).toBe(true);
    expect((by.Right ?? []).every((f) => f.x >= 300)).toBe(true);
  });

  test("stacked blocks still pair each date with the signature above it", async () => {
    const req = await createMultiSignerRequest(db, {
      name: "Stacked agreement",
      pdf: await pdfWithBlocks([
        { x: 72, y: 400 },
        { x: 72, y: 250 },
      ]),
      signers: [{ name: "First" }, { name: "Second" }],
    });
    const by = await fieldsBySigner(req.id);
    expect((by.First ?? []).map((f) => f.type).sort()).toEqual([
      "date",
      "signature",
    ]);
    expect((by.Second ?? []).map((f) => f.type).sort()).toEqual([
      "date",
      "signature",
    ]);
  });
});
