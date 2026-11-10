/**
 * Signet lifecycle events, emitted to Vortex as CloudEvents.
 *
 * Source is `omni.signet` (set once on the provider). Types follow the fleet
 * `<product>.<entity>.<action>` convention. The document id is the `subject`
 * so Vortex partitions a document's events together. Emission is best-effort
 * and fire-and-forget: a Vortex outage never blocks or fails a signing
 * operation, and with no Vortex configured the provider is a noop.
 *
 * The event builders are pure (lifecycle data in, CloudEvents input out) so
 * their shapes can be unit-tested without a live provider.
 */

import type { EventInput } from "@omnidotdev/providers/events";
import { events } from "../providers/index.ts";

export interface DocumentEvent {
  documentId: string;
  name: string;
  ownerId: string | null;
  signerCount: number;
  signingMode: string;
}

export interface SignatureEvent {
  documentId: string;
  signerId: string;
  signerName: string;
  ownerId: string | null;
}

/** A document (and its signing request) was created */
export const documentCreatedEvent = (
  d: DocumentEvent & { fieldCount: number },
): EventInput => ({
  type: "signet.document.created",
  subject: d.documentId,
  data: {
    documentId: d.documentId,
    name: d.name,
    ownerId: d.ownerId,
    signerCount: d.signerCount,
    signingMode: d.signingMode,
    fieldCount: d.fieldCount,
  },
});

/** A document was sent to its signers */
export const documentSentEvent = (d: DocumentEvent): EventInput => ({
  type: "signet.document.sent",
  subject: d.documentId,
  data: {
    documentId: d.documentId,
    name: d.name,
    ownerId: d.ownerId,
    signerCount: d.signerCount,
    signingMode: d.signingMode,
  },
});

/** A single signer completed their signature */
export const signatureCompletedEvent = (s: SignatureEvent): EventInput => ({
  type: "signet.signature.completed",
  subject: s.documentId,
  data: {
    documentId: s.documentId,
    signerId: s.signerId,
    signerName: s.signerName,
    ownerId: s.ownerId,
  },
});

/** Every signer has signed and the document was sealed */
export const documentCompletedEvent = (
  d: Omit<DocumentEvent, "signingMode">,
): EventInput => ({
  type: "signet.document.completed",
  subject: d.documentId,
  data: {
    documentId: d.documentId,
    name: d.name,
    ownerId: d.ownerId,
    signerCount: d.signerCount,
  },
});

/** A document was voided before completion */
export const documentVoidedEvent = (d: {
  documentId: string;
  ownerId: string | null;
}): EventInput => ({
  type: "signet.document.voided",
  subject: d.documentId,
  data: { documentId: d.documentId, ownerId: d.ownerId },
});

/** Fire-and-forget emit: never throws into the caller, logs on failure */
const emit = (event: EventInput): void => {
  events
    .emit(event)
    .catch((err) =>
      console.warn("[signet] event emit failed", event.type, err),
    );
};

export const emitDocumentCreated = (
  d: DocumentEvent & { fieldCount: number },
): void => emit(documentCreatedEvent(d));

export const emitDocumentSent = (d: DocumentEvent): void =>
  emit(documentSentEvent(d));

export const emitSignatureCompleted = (s: SignatureEvent): void =>
  emit(signatureCompletedEvent(s));

export const emitDocumentCompleted = (
  d: Omit<DocumentEvent, "signingMode">,
): void => emit(documentCompletedEvent(d));

export const emitDocumentVoided = (d: {
  documentId: string;
  ownerId: string | null;
}): void => emit(documentVoidedEvent(d));
