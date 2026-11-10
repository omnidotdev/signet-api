import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../test/testDb.ts";
import type { Db } from "../db/client.ts";
import { document } from "../db/schema.ts";
import { createSigningRequest } from "../documents/documentService.ts";
import { signSession, verifySession } from "./session.ts";

const tinyPdf = async () => {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
};

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

describe("organization scoping", () => {
  test("stamps the sender's workspace on a new document", async () => {
    const req = await createSigningRequest(db, {
      name: "D",
      pdf: await tinyPdf(),
      signerName: "Ada",
      ownerId: "owner-1",
      organizationId: "org-9",
    });
    const [row] = await db
      .select()
      .from(document)
      .where(eq(document.id, req.id));
    expect(row?.organizationId).toBe("org-9");
  });

  test("anonymous sends carry no workspace", async () => {
    const req = await createSigningRequest(db, {
      name: "D",
      pdf: await tinyPdf(),
      signerName: "Ada",
    });
    const [row] = await db
      .select()
      .from(document)
      .where(eq(document.id, req.id));
    expect(row?.organizationId).toBeNull();
  });

  test("the session cookie round-trips the active workspace", async () => {
    const secret = "test-secret-at-least-32-bytes-long!!";
    const token = await signSession(
      { sub: "u1", email: "u@example.com", organizationId: "org-9" },
      secret,
    );
    const session = await verifySession(token, secret);
    expect(session?.organizationId).toBe("org-9");
  });
});
