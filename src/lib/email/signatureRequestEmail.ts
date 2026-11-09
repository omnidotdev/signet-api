import { notifications } from "../providers/index.ts";

export interface SignatureRequestEmail {
  to: string;
  signerName: string;
  documentName: string;
  signUrl: string;
}

// Email clients do not support CSS custom properties, so the Sigil token values
// (citrine accent #be6221, neutral fg #0a0a0a / #525252 / #737373, radius-lg
// 8px) are inlined as literal hex here to match the app's token-based styling
const renderBody = (input: SignatureRequestEmail): string => `
<div style="font-family: ui-sans-serif, system-ui, sans-serif; max-width: 480px; margin: 0 auto; color: #0a0a0a;">
  <h1 style="font-size: 20px; letter-spacing: -0.02em;">Signature requested</h1>
  <p>Hi ${input.signerName}, you have been asked to sign <strong>${input.documentName}</strong>.</p>
  <p style="margin: 24px 0;">
    <a href="${input.signUrl}" style="background: #be6221; color: #ffffff; padding: 12px 20px; border-radius: 8px; text-decoration: none; font-weight: 600;">Review and sign</a>
  </p>
  <p style="font-size: 13px; color: #525252;">Or open this link: ${input.signUrl}</p>
  <p style="font-size: 12px; color: #737373;">Signed documents carry a verifiable signature and provenance trail.</p>
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
