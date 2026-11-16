/** Capitalize the first letter, so unknown events read like the labeled ones */
const sentenceCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const EVENT_LABEL: Record<string, string> = {
  "document.created": "Created",
  "document.sent": "Sent for signature",
  "document.viewed": "Opened by a signer",
  "document.signed": "Signed",
  "signature.completed": "Signed",
  "document.completed": "Completed and sealed",
  "document.declined": "Declined",
  "document.voided": "Voided",
  "document.expired": "Expired",
  "document.revised": "Created as a new version",
  "identity.verified": "Identity verified",
  "signer.added": "Signer added",
  "signer.removed": "Signer removed",
  "signer.corrected": "Signer updated",
};

/** Human label for a provenance event type, sentence case */
export const eventLabel = (type: string) =>
  EVENT_LABEL[type] ??
  sentenceCase(type.replace(/^[a-z]+\./, "").replace(/[._]/g, " "));
