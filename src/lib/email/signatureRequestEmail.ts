import { notifications } from "../providers/index.ts";
import { emailShell, escapeHtml } from "./shell.ts";

export interface SignatureRequestEmail {
  to: string;
  signerName: string;
  documentName: string;
  signUrl: string;
}

const renderBody = (input: SignatureRequestEmail): string =>
  emailShell({
    title: `Signature requested: ${input.documentName}`,
    heading: "You have a document to sign",
    body: `<p style="margin:0;">Hi ${escapeHtml(input.signerName)}, <strong>${escapeHtml(input.documentName)}</strong> is ready for your signature.</p>`,
    button: { url: input.signUrl, label: "Review and sign" },
    note: "Signed documents carry a verifiable signature and a provenance trail.",
  });

/**
 * Email a signer their signing link. Best-effort: a delivery failure is logged
 * and swallowed so creating the signing request never fails on email
 */
export const sendSignatureRequestEmail = async (
  input: SignatureRequestEmail,
): Promise<void> => {
  try {
    await notifications.sendEmail({
      to: input.to,
      subject: `Signature requested: ${input.documentName}`,
      body: renderBody(input),
      html: true,
    });
  } catch (err) {
    console.warn("[signet] signature-request email failed", err);
  }
};
