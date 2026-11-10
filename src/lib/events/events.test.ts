import { describe, expect, test } from "bun:test";
import {
  documentCompletedEvent,
  documentCreatedEvent,
  documentSentEvent,
  documentVoidedEvent,
  signatureCompletedEvent,
} from "./signetEvents.ts";

describe("signet event builders", () => {
  test("document.created carries the document shape and partitions by id", () => {
    const e = documentCreatedEvent({
      documentId: "doc-1",
      name: "NDA",
      ownerId: "owner-1",
      signerCount: 2,
      signingMode: "sequential",
      fieldCount: 3,
    });
    expect(e.type).toBe("signet.document.created");
    expect(e.subject).toBe("doc-1");
    expect(e.data).toEqual({
      documentId: "doc-1",
      name: "NDA",
      ownerId: "owner-1",
      signerCount: 2,
      signingMode: "sequential",
      fieldCount: 3,
    });
  });

  test("document.sent omits the field count but keeps the mode", () => {
    const e = documentSentEvent({
      documentId: "doc-2",
      name: "Lease",
      ownerId: null,
      signerCount: 1,
      signingMode: "parallel",
    });
    expect(e.type).toBe("signet.document.sent");
    expect(e.subject).toBe("doc-2");
    expect(e.data.ownerId).toBeNull();
    expect(e.data).not.toHaveProperty("fieldCount");
  });

  test("signature.completed identifies the signer within the document", () => {
    const e = signatureCompletedEvent({
      documentId: "doc-3",
      signerId: "sgn-9",
      signerName: "Ada Lovelace",
      ownerId: "owner-1",
    });
    expect(e.type).toBe("signet.signature.completed");
    expect(e.subject).toBe("doc-3");
    expect(e.data).toEqual({
      documentId: "doc-3",
      signerId: "sgn-9",
      signerName: "Ada Lovelace",
      ownerId: "owner-1",
    });
  });

  test("document.completed reports the final signer count", () => {
    const e = documentCompletedEvent({
      documentId: "doc-4",
      name: "MSA",
      ownerId: "owner-2",
      signerCount: 3,
    });
    expect(e.type).toBe("signet.document.completed");
    expect(e.data.signerCount).toBe(3);
    expect(e.data).not.toHaveProperty("signingMode");
  });

  test("document.voided is minimal", () => {
    const e = documentVoidedEvent({ documentId: "doc-5", ownerId: null });
    expect(e.type).toBe("signet.document.voided");
    expect(e.subject).toBe("doc-5");
    expect(e.data).toEqual({ documentId: "doc-5", ownerId: null });
  });
});
