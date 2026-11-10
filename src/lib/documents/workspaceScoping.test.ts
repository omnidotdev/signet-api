import { beforeEach, describe, expect, test } from "bun:test";
import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import type { ServiceSigner } from "../signing/signerIdentity.ts";
import { generateSelfSignedPkcs12 } from "../signing/signerIdentity.ts";
import {
  createSigningRequest,
  getSignedPdfForMember,
  listWorkspaceDocuments,
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

  test("a workspace member can download; a non-member cannot", async () => {
    const req = await make(db, { ownerId: "alice", organizationId: "ws-a" });
    await signByToken(db, serviceSigner, req.signToken);

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
