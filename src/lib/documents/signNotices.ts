import type { CompletionEmail } from "../email/completionEmail.ts";
import type { SignatureRequestEmail } from "../email/signatureRequestEmail.ts";
import type {
  SignedReceiptEmail,
  SignerProgressEmail,
} from "../email/signProgressEmail.ts";
import type { SignResult } from "./documentService.ts";

export type SignNotice =
  | { kind: "request"; email: SignatureRequestEmail }
  | { kind: "completion"; email: CompletionEmail }
  | { kind: "receipt"; email: SignedReceiptEmail }
  | { kind: "progress"; email: SignerProgressEmail };

const sameEmail = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

/**
 * The emails a signature sets off. While others still have to sign, the signer
 * gets a receipt, the sender hears who signed and who is left, and in a
 * sequential flow the next signer gets their link. Once everyone has signed,
 * every signer and the sender get the finished document
 */
export const signNotices = (
  result: SignResult,
  appBaseUrl: string,
): SignNotice[] => {
  if (!result.ok) return [];
  const notices: SignNotice[] = [];

  if (result.notifySigner?.email) {
    notices.push({
      kind: "request",
      email: {
        to: result.notifySigner.email,
        signerName: result.notifySigner.name,
        documentName: result.notifySigner.documentName,
        signUrl: `${appBaseUrl}/sign/${result.notifySigner.signToken}`,
      },
    });
  }

  if (result.progress) {
    const { documentName, ownerEmail, signer, waitingOn } = result.progress;
    if (signer.email) {
      notices.push({
        kind: "receipt",
        email: {
          to: signer.email,
          signerName: signer.name,
          documentName,
          viewUrl: `${appBaseUrl}/sign/${signer.signToken}`,
        },
      });
    }
    // a sender signing their own document already knows
    if (ownerEmail && !sameEmail(ownerEmail, signer.email)) {
      notices.push({
        kind: "progress",
        email: {
          to: ownerEmail,
          signerName: signer.name,
          documentName,
          waitingOn,
          manageUrl: `${appBaseUrl}/documents/${result.documentId}`,
        },
      });
    }
  }

  if (result.completion) {
    const { documentName, ownerEmail, signers } = result.completion;
    for (const s of signers) {
      if (!s.email) continue;
      notices.push({
        kind: "completion",
        email: {
          to: s.email,
          recipientName: s.name,
          documentName,
          downloadUrl: `${appBaseUrl}/sign/${s.signToken}`,
        },
      });
    }
    // the sender, when they are not themselves a signer already emailed
    if (ownerEmail && !signers.some((s) => sameEmail(s.email, ownerEmail))) {
      notices.push({
        kind: "completion",
        email: {
          to: ownerEmail,
          recipientName: "there",
          documentName,
          downloadUrl: `${appBaseUrl}/documents/${result.documentId}`,
        },
      });
    }
  }

  return notices;
};
