import { notifications } from "../providers/index.ts";

export interface SignatureRequestEmail {
  to: string;
  signerName: string;
  documentName: string;
  signUrl: string;
}

/** Render the signing-request email body */
const renderBody = (input: SignatureRequestEmail): string => `
<div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; color: #1c1917;">
  <h1 style="font-size: 20px;">Signature requested</h1>
  <p>Hi ${input.signerName}, you have been asked to sign <strong>${input.documentName}</strong>.</p>
  <p style="margin: 24px 0;">
    <a href="${input.signUrl}" style="background: #b45309; color: #fff; padding: 12px 20px; border-radius: 9px; text-decoration: none; font-weight: 600;">Review and sign</a>
  </p>
  <p style="font-size: 13px; color: #78716c;">Or open this link: ${input.signUrl}</p>
  <p style="font-size: 12px; color: #a8a29e;">Signed documents carry a verifiable signature and provenance trail.</p>
</div>`;

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
