import { beforeEach, describe, expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { createDraft, getEditorData, saveFields } from "./documentService.ts";
import {
  createDraftFromTemplate,
  listTemplates,
  saveTemplateFromDraft,
} from "./templateService.ts";

const tinyPdf = async () => {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
};

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

describe("templates", () => {
  test("saves a draft layout and starts a new draft from it", async () => {
    const draft = await createDraft(db, {
      name: "NDA",
      pdf: await tinyPdf(),
      signers: [{ name: "Owner Draft" }],
      ownerId: "owner-1",
      ownerEmail: "owner@example.com",
    });
    const editor = await getEditorData(db, draft.id, draft.manageToken);
    const signerId = editor?.signers[0]?.id ?? null;
    await saveFields(db, draft.id, draft.manageToken, [
      {
        signerId,
        type: "signature",
        page: 1,
        x: 120,
        y: 400,
        width: 160,
        height: 18,
      },
      {
        signerId,
        type: "date",
        page: 1,
        x: 120,
        y: 360,
        width: 90,
        height: 16,
      },
    ]);

    const saved = await saveTemplateFromDraft(db, draft.id, draft.manageToken);
    expect(saved?.id).toBeString();

    const templates = await listTemplates(db, "owner-1");
    expect(templates).toHaveLength(1);
    expect(templates[0]?.name).toBe("NDA");
    expect(templates[0]?.fieldCount).toBe(2);

    // start a new draft from the template with a different signer
    const fromTpl = await createDraftFromTemplate(
      db,
      templates[0]?.id as string,
      "owner-1",
      [{ name: "New Signer" }],
    );
    expect(fromTpl?.id).toBeString();

    const newEditor = await getEditorData(
      db,
      fromTpl?.id as string,
      fromTpl?.manageToken as string,
    );
    // the template's two fields are placed and assigned to the signer
    expect(newEditor?.fields).toHaveLength(2);
    expect(newEditor?.fields.map((f) => f.type).sort()).toEqual([
      "date",
      "signature",
    ]);
    expect(newEditor?.fields.every((f) => f.signerId)).toBe(true);
    expect(newEditor?.signers[0]?.name).toBe("New Signer");
  });

  test("a draft with no owner cannot be saved as a template", async () => {
    const draft = await createDraft(db, {
      name: "Anon",
      pdf: await tinyPdf(),
      signers: [{ name: "Someone" }],
    });
    expect(
      await saveTemplateFromDraft(db, draft.id, draft.manageToken),
    ).toBeNull();
  });

  test("a template is scoped to its owner", async () => {
    const draft = await createDraft(db, {
      name: "Owned",
      pdf: await tinyPdf(),
      signers: [{ name: "X" }],
      ownerId: "owner-1",
    });
    await saveTemplateFromDraft(db, draft.id, draft.manageToken);
    const [tpl] = await listTemplates(db, "owner-1");
    expect(
      await createDraftFromTemplate(db, tpl?.id as string, "other-owner", [
        { name: "Y" },
      ]),
    ).toBeNull();
    expect(await listTemplates(db, "other-owner")).toHaveLength(0);
  });
});
