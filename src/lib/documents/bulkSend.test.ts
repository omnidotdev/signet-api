import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";

import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { document, signer } from "../db/schema.ts";
import { createDraft, getEditorData, saveFields } from "./documentService.ts";
import {
  BULK_SEND_MAX,
  bulkSendFromTemplate,
  listTemplates,
  saveTemplateFromDraft,
} from "./templateService.ts";

const tinyPdf = async () => {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
};

let db: Db;

/** A two-role template (employee signs, then HR countersigns) owned by owner-1 */
const twoRoleTemplate = async (): Promise<string> => {
  const draft = await createDraft(db, {
    name: "Offer letter",
    pdf: await tinyPdf(),
    signers: [{ name: "Employee" }, { name: "HR" }],
    ownerId: "owner-1",
  });
  const editor = await getEditorData(db, draft.id, draft.manageToken);
  const [a, b] = editor?.signers ?? [];
  await saveFields(db, draft.id, draft.manageToken, [
    {
      signerId: a?.id ?? null,
      type: "signature",
      page: 1,
      x: 72,
      y: 400,
      width: 160,
      height: 18,
    },
    {
      signerId: b?.id ?? null,
      type: "signature",
      page: 1,
      x: 300,
      y: 400,
      width: 160,
      height: 18,
    },
  ]);
  await saveTemplateFromDraft(db, draft.id, draft.manageToken);
  const [tpl] = await listTemplates(db, "owner-1");
  return tpl?.id as string;
};

const hr = { name: "Hannah HR", email: "hr@example.com" };
const row = (n: number) => [
  { name: `Employee ${n}`, email: `e${n}@example.com` },
  hr,
];

beforeEach(async () => {
  db = await createTestDb();
});

describe("bulk send from a template", () => {
  test("creates and sends one document per row, each with its own signers", async () => {
    const templateId = await twoRoleTemplate();
    const result = await bulkSendFromTemplate(db, {
      templateId,
      ownerId: "owner-1",
      workspaceIds: [],
      rows: [row(1), row(2), row(3)],
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.sent).toHaveLength(3);
    expect(result.failed).toEqual([]);

    const ids = result.sent.map((s) => s.documentId);
    expect(new Set(ids).size).toBe(3);
    for (const [i, sent] of result.sent.entries()) {
      const [doc] = await db
        .select()
        .from(document)
        .where(eq(document.id, sent.documentId));
      expect(doc?.status).toBe("sent");
      const signers = await db
        .select()
        .from(signer)
        .where(eq(signer.documentId, sent.documentId));
      expect(signers.map((s) => s.email).sort()).toEqual(
        [`e${i + 1}@example.com`, "hr@example.com"].sort(),
      );
      expect(sent.signers.every((s) => s.signToken.length > 10)).toBe(true);
    }
  });

  test("rejects the whole batch when any row is missing a role or an email", async () => {
    const templateId = await twoRoleTemplate();
    const result = await bulkSendFromTemplate(db, {
      templateId,
      ownerId: "owner-1",
      workspaceIds: [],
      rows: [
        row(1),
        [{ name: "No HR", email: "x@example.com" }],
        [{ name: "Bad", email: "not-an-email" }, hr],
      ],
    });
    expect(result).toEqual({ ok: false, error: "invalid_rows", rows: [1, 2] });
    // nothing was created: validation happens before any document exists
    expect(await db.select().from(document)).toHaveLength(1);
  });

  test("caps the batch size", async () => {
    const templateId = await twoRoleTemplate();
    const rows = Array.from({ length: BULK_SEND_MAX + 1 }, (_, i) => row(i));
    expect(
      await bulkSendFromTemplate(db, {
        templateId,
        ownerId: "owner-1",
        workspaceIds: [],
        rows,
      }),
    ).toEqual({ ok: false, error: "too_many_rows" });
  });

  test("an empty batch is refused", async () => {
    const templateId = await twoRoleTemplate();
    expect(
      await bulkSendFromTemplate(db, {
        templateId,
        ownerId: "owner-1",
        workspaceIds: [],
        rows: [],
      }),
    ).toEqual({ ok: false, error: "no_rows" });
  });

  test("only the template's owner can bulk send it", async () => {
    const templateId = await twoRoleTemplate();
    expect(
      await bulkSendFromTemplate(db, {
        templateId,
        ownerId: "someone-else",
        workspaceIds: [],
        rows: [row(1)],
      }),
    ).toEqual({ ok: false, error: "not_found" });
  });
});
