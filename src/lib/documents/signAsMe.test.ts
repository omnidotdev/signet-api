import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";

import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { signer } from "../db/schema.ts";
import { createDraft, sendDraft } from "./documentService.ts";
import { resolveMySignToken } from "./signAsMe.ts";

const tinyPdf = async (): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
};

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

describe("resolveMySignToken", () => {
  test("returns the signer's token for a matching email, case-insensitively", async () => {
    const draft = await createDraft(db, {
      name: "NDA",
      pdf: await tinyPdf(),
      signers: [{ name: "Me", email: "Me@Omni.dev" }],
    });
    const sent = await sendDraft(db, draft.id, draft.manageToken);
    const expected = sent?.signers[0]?.signToken;
    expect(await resolveMySignToken(db, draft.id, "me@omni.dev")).toBe(
      expected as string,
    );
  });

  test("returns null for an email that is not a signer", async () => {
    const draft = await createDraft(db, {
      name: "NDA",
      pdf: await tinyPdf(),
      signers: [{ name: "Me", email: "me@omni.dev" }],
    });
    await sendDraft(db, draft.id, draft.manageToken);
    expect(await resolveMySignToken(db, draft.id, "other@omni.dev")).toBeNull();
  });

  test("returns null for a draft that has not been sent", async () => {
    const draft = await createDraft(db, {
      name: "NDA",
      pdf: await tinyPdf(),
      signers: [{ name: "Me", email: "me@omni.dev" }],
    });
    expect(await resolveMySignToken(db, draft.id, "me@omni.dev")).toBeNull();
  });

  test("returns null once the signer has already signed", async () => {
    const draft = await createDraft(db, {
      name: "NDA",
      pdf: await tinyPdf(),
      signers: [{ name: "Me", email: "me@omni.dev" }],
    });
    await sendDraft(db, draft.id, draft.manageToken);
    await db
      .update(signer)
      .set({ status: "signed" })
      .where(eq(signer.documentId, draft.id));
    expect(await resolveMySignToken(db, draft.id, "me@omni.dev")).toBeNull();
  });
});
