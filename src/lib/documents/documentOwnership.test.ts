import { beforeEach, describe, expect, test } from "bun:test";
import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { createSampleDocument } from "../signing/sampleDocument.ts";
import type { ServiceSigner } from "../signing/signerIdentity.ts";
import { generateSelfSignedPkcs12 } from "../signing/signerIdentity.ts";
import {
  createSigningRequest,
  getSignedPdfForOwner,
  listDocumentsByOwner,
  signByToken,
} from "./documentService.ts";

const serviceSigner: ServiceSigner = {
  pkcs12: generateSelfSignedPkcs12({ commonName: "Signet" }),
  passphrase: "",
  commonName: "Signet",
  ephemeral: true,
};

let db: Db;
let pdf: Uint8Array;

beforeEach(async () => {
  db = await createTestDb();
  pdf = await createSampleDocument({ title: "NDA" });
});

const create = (name: string, ownerId?: string) =>
  createSigningRequest(db, {
    name,
    pdf,
    signerName: "Ada Lovelace",
    signerEmail: "ada@example.com",
    ownerId,
    ownerEmail: ownerId ? "owner@example.com" : undefined,
  });

describe("document ownership", () => {
  test("lists only the owner's documents, newest first", async () => {
    await create("First", "user-a");
    await create("Second", "user-a");
    await create("Someone else", "user-b");
    await create("Anonymous");

    const docs = await listDocumentsByOwner(db, "user-a");
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.name)).toEqual(["Second", "First"]);
    expect(docs[0]?.status).toBe("sent");
    expect(docs[0]?.signerName).toBe("Ada Lovelace");
  });

  test("returns nothing for an owner with no documents", async () => {
    await create("Anonymous");
    expect(await listDocumentsByOwner(db, "nobody")).toHaveLength(0);
  });

  test("hands the signed PDF only to the owner, once signed", async () => {
    const req = await create("Owned", "user-a");

    expect(await getSignedPdfForOwner(db, req.id, "user-a")).toBeNull();

    const result = await signByToken(
      db,
      serviceSigner,
      req.signToken,
      undefined,
      { consent: true },
    );
    expect(result.ok).toBe(true);

    const mine = await getSignedPdfForOwner(db, req.id, "user-a");
    expect(mine).toBeInstanceOf(Uint8Array);
    expect(await getSignedPdfForOwner(db, req.id, "user-b")).toBeNull();

    const docs = await listDocumentsByOwner(db, "user-a");
    expect(docs[0]?.hasSignedPdf).toBe(true);
    expect(docs[0]?.status).toBe("completed");
  });

  test("leaves anonymous sends unowned", async () => {
    const req = await create("Anon");
    expect(await getSignedPdfForOwner(db, req.id, "user-a")).toBeNull();
  });
});
