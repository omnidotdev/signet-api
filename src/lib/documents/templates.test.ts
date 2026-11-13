import { beforeEach, describe, expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { createDraft, getEditorData, saveFields } from "./documentService.ts";
import {
  createDraftFromTemplate,
  listTemplates,
  saveTemplateFromDraft,
  saveTemplateFromOwnedDraft,
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
    if (!fromTpl.ok) throw new Error(fromTpl.error);
    expect(fromTpl.draft.id).toBeString();

    const newEditor = await getEditorData(
      db,
      fromTpl.draft.id,
      fromTpl.draft.manageToken,
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

  test("saves an owned draft as a template by owner id, not manage token", async () => {
    const draft = await createDraft(db, {
      name: "Owner Scoped",
      pdf: await tinyPdf(),
      signers: [{ name: "Owner Draft" }],
      ownerId: "owner-9",
    });
    // a different owner cannot save it
    expect(
      await saveTemplateFromOwnedDraft(db, draft.id, "someone-else", []),
    ).toBeNull();
    // the owner can
    const saved = await saveTemplateFromOwnedDraft(db, draft.id, "owner-9", []);
    expect(saved?.id).toBeString();
    expect(await listTemplates(db, "owner-9")).toHaveLength(1);
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
    ).toEqual({ ok: false, error: "not_found" });
    expect(await listTemplates(db, "other-owner")).toHaveLength(0);
  });

  test("a multi-signer template keeps each field with its signer's role", async () => {
    const draft = await createDraft(db, {
      name: "Lease",
      pdf: await tinyPdf(),
      signers: [{ name: "Tenant Draft" }, { name: "Landlord Draft" }],
      ownerId: "owner-1",
    });
    const editor = await getEditorData(db, draft.id, draft.manageToken);
    const [tenant, landlord] = editor?.signers ?? [];
    await saveFields(db, draft.id, draft.manageToken, [
      {
        signerId: tenant?.id ?? null,
        type: "signature",
        page: 1,
        x: 72,
        y: 400,
        width: 160,
        height: 18,
      },
      {
        signerId: landlord?.id ?? null,
        type: "signature",
        page: 1,
        x: 300,
        y: 400,
        width: 160,
        height: 18,
      },
      {
        signerId: landlord?.id ?? null,
        type: "date",
        page: 1,
        x: 300,
        y: 360,
        width: 90,
        height: 16,
      },
    ]);
    await saveTemplateFromDraft(db, draft.id, draft.manageToken);
    const [tpl] = await listTemplates(db, "owner-1");
    expect(tpl?.roles).toEqual(["Signer 1", "Signer 2"]);

    const started = await createDraftFromTemplate(
      db,
      tpl?.id as string,
      "owner-1",
      [{ name: "Ada (tenant)" }, { name: "Grace (landlord)" }],
    );
    if (!started.ok) throw new Error(started.error);
    const next = await getEditorData(
      db,
      started.draft.id,
      started.draft.manageToken,
    );
    const idByName = new Map(next?.signers.map((s) => [s.name, s.id]));
    const owner = (x: number, type: string) =>
      next?.fields.find((f) => f.x === x && f.type === type)?.signerId;
    expect(owner(72, "signature")).toBe(idByName.get("Ada (tenant)"));
    expect(owner(300, "signature")).toBe(idByName.get("Grace (landlord)"));
    expect(owner(300, "date")).toBe(idByName.get("Grace (landlord)"));
  });

  test("starting a multi-signer template needs a signer for every role", async () => {
    const draft = await createDraft(db, {
      name: "Lease",
      pdf: await tinyPdf(),
      signers: [{ name: "A" }, { name: "B" }],
      ownerId: "owner-1",
    });
    await saveTemplateFromDraft(db, draft.id, draft.manageToken);
    const [tpl] = await listTemplates(db, "owner-1");
    expect(
      await createDraftFromTemplate(db, tpl?.id as string, "owner-1", [
        { name: "Only one" },
      ]),
    ).toEqual({ ok: false, error: "signers_for_each_role" });
  });

  test("a template keeps each field's options, requirement and styling", async () => {
    const draft = await createDraft(db, {
      name: "Form",
      pdf: await tinyPdf(),
      signers: [{ name: "A" }],
      ownerId: "owner-1",
    });
    const editor = await getEditorData(db, draft.id, draft.manageToken);
    const signerId = editor?.signers[0]?.id ?? null;
    await saveFields(db, draft.id, draft.manageToken, [
      {
        signerId,
        type: "dropdown",
        page: 1,
        x: 72,
        y: 500,
        width: 160,
        height: 18,
        options: ["Red", "Blue"],
        required: false,
        color: "#aa0000",
      },
      {
        signerId,
        type: "date",
        page: 1,
        x: 72,
        y: 450,
        width: 90,
        height: 16,
        dateFormat: "long",
      },
    ]);
    await saveTemplateFromDraft(db, draft.id, draft.manageToken);
    const [tpl] = await listTemplates(db, "owner-1");
    const started = await createDraftFromTemplate(
      db,
      tpl?.id as string,
      "owner-1",
      [{ name: "B" }],
    );
    if (!started.ok) throw new Error(started.error);
    const next = await getEditorData(
      db,
      started.draft.id,
      started.draft.manageToken,
    );
    const dropdown = next?.fields.find((f) => f.type === "dropdown");
    expect(dropdown?.options).toEqual(["Red", "Blue"]);
    expect(dropdown?.required).toBe(false);
    expect(dropdown?.color).toBe("#aa0000");
    expect(next?.fields.find((f) => f.type === "date")?.dateFormat).toBe(
      "long",
    );
  });
});
