import { beforeEach, describe, expect, test } from "bun:test";
import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import type { ServiceSigner } from "../signing/signerIdentity.ts";
import { generateSelfSignedPkcs12 } from "../signing/signerIdentity.ts";
import {
  createMultiSignerRequest,
  createSigningRequest,
  getDocumentDetailForOwner,
  getDocumentFileForOwner,
  getEditorDataForOwner,
  getSignedPdfForMember,
  listWorkspaceDocuments,
  remindOwnedDocument,
  saveFieldsForOwner,
  signByToken,
} from "./documentService.ts";

const serviceSigner: ServiceSigner = {
  pkcs12: generateSelfSignedPkcs12({ commonName: "Signet" }),
  passphrase: "",
  commonName: "Signet",
  ephemeral: true,
};

const tinyPdf = async () => {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
};

const make = (db: Db, opts: { ownerId?: string; organizationId?: string }) =>
  (async () =>
    createSigningRequest(db, {
      name: "Doc",
      pdf: await tinyPdf(),
      signerName: "Ada",
      ...opts,
    }))();

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

describe("workspace-scoped documents", () => {
  test("lists the active workspace's documents plus the sender's own", async () => {
    await make(db, { ownerId: "alice", organizationId: "ws-a" }); // in ws-a
    await make(db, { ownerId: "bob", organizationId: "ws-a" }); // ws-a, not alice's
    await make(db, { ownerId: "bob", organizationId: "ws-b" }); // other workspace
    await make(db, { ownerId: "alice", organizationId: null as never }); // alice's, unfiled

    // Alice viewing ws-a sees: ws-a docs (both) + her unfiled one; never ws-b
    const docs = await listWorkspaceDocuments(db, "alice", "ws-a");
    expect(docs).toHaveLength(3);
  });

  test("the owner can open a sent document's file before it is signed", async () => {
    const req = await createSigningRequest(db, {
      name: "Pending",
      pdf: await tinyPdf(),
      signerName: "Ada",
      ownerId: "alice",
    });
    const file = await getDocumentFileForOwner(db, req.id, "alice", []);
    expect(file?.signed).toBe(false);
    expect(file?.bytes.length ?? 0).toBeGreaterThan(0);
    // once signed, the same call returns the sealed PDF
    await signByToken(db, serviceSigner, req.signToken, "Ada", {
      consent: true,
    });
    const after = await getDocumentFileForOwner(db, req.id, "alice", []);
    expect(after?.signed).toBe(true);
    // a stranger gets nothing
    expect(await getDocumentFileForOwner(db, req.id, "eve", [])).toBeNull();
  });

  test("the owner can see status and history, and resend a reminder", async () => {
    const req = await createSigningRequest(db, {
      name: "Agreement",
      pdf: await tinyPdf(),
      signerName: "Ada",
      signerEmail: "ada@example.com",
      ownerId: "alice",
    });

    const mine = await getDocumentDetailForOwner(db, req.id, "alice", []);
    expect(mine?.status).toBe("sent");
    expect(mine?.signers[0]?.active).toBe(true);
    expect(mine?.history.map((h) => h.type)).toContain("document.created");
    expect(mine?.provenanceValid).toBe(true);

    // a non-owner sees nothing
    expect(
      await getDocumentDetailForOwner(db, req.id, "mallory", []),
    ).toBeNull();

    const remind = await remindOwnedDocument(db, req.id, "alice", []);
    expect(remind?.signers).toHaveLength(1);
    expect(remind?.signers[0]?.email).toBe("ada@example.com");

    // once signed, there is no one to remind
    await signByToken(db, serviceSigner, req.signToken, "Ada", {
      consent: true,
    });
    expect(await remindOwnedDocument(db, req.id, "alice", [])).toBeNull();
  });

  test("the owner can load and replace a draft's fields", async () => {
    const draft = await createMultiSignerRequest(db, {
      name: "Draft",
      pdf: await tinyPdf(),
      signers: [{ name: "Ada" }],
      ownerId: "alice",
      draft: true,
    });

    const data = await getEditorDataForOwner(db, draft.id, "alice", []);
    expect(data?.signers).toHaveLength(1);
    expect(data?.pdfBase64.length).toBeGreaterThan(0);

    // a non-owner cannot load the editor
    expect(await getEditorDataForOwner(db, draft.id, "eve", [])).toBeNull();

    const signerId = data?.signers[0]?.id as string;
    const ok = await saveFieldsForOwner(
      db,
      draft.id,
      "alice",
      [],
      [
        {
          signerId,
          type: "signature",
          page: 1,
          x: 72,
          y: 100,
          width: 150,
          height: 24,
        },
        {
          signerId,
          type: "date",
          page: 1,
          x: 240,
          y: 100,
          width: 100,
          height: 24,
        },
      ],
    );
    expect(ok).toBe(true);

    const after = await getEditorDataForOwner(db, draft.id, "alice", []);
    expect(after?.fields).toHaveLength(2);
    // a non-owner cannot save
    expect(await saveFieldsForOwner(db, draft.id, "eve", [], [])).toBe(false);
  });

  test("a multi-signer document appears once, with its signer count", async () => {
    await createMultiSignerRequest(db, {
      name: "Operating Agreement",
      pdf: await tinyPdf(),
      signers: [{ name: "Ada" }, { name: "Grace" }, { name: "Linus" }],
      ownerId: "alice",
    });
    const docs = await listWorkspaceDocuments(db, "alice", undefined);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.signerCount).toBe(3);
    expect(docs[0]?.signerName).toBe("Ada");
  });

  test("a workspace member can download; a non-member cannot", async () => {
    const req = await make(db, { ownerId: "alice", organizationId: "ws-a" });
    await signByToken(db, serviceSigner, req.signToken, undefined, {
      consent: true,
    });

    // owner
    expect(await getSignedPdfForMember(db, req.id, "alice", [])).not.toBeNull();
    // a member of ws-a who is not the owner
    expect(
      await getSignedPdfForMember(db, req.id, "carol", ["ws-a"]),
    ).not.toBeNull();
    // neither owner nor a member of ws-a
    expect(
      await getSignedPdfForMember(db, req.id, "dave", ["ws-x"]),
    ).toBeNull();
  });

  test("an unsigned document has nothing to download", async () => {
    const req = await make(db, { ownerId: "alice", organizationId: "ws-a" });
    expect(
      await getSignedPdfForMember(db, req.id, "alice", ["ws-a"]),
    ).toBeNull();
  });
});
