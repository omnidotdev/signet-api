import { notifications } from "../providers/index.ts";

export interface CompletionEmail {
  to: string;
  recipientName: string;
  documentName: string;
  /** where this recipient can view and download the finished document */
  downloadUrl: string;
}

// Token values inlined as literal hex (email clients ignore CSS variables), to
// match the app's Sigil-token styling: citrine accent #be6221, fg #0a0a0a /
// #525252 / #737373, radius-lg 8px
const renderBody = (input: CompletionEmail): string => `
<div style="font-family: ui-sans-serif, system-ui, sans-serif; max-width: 480px; margin: 0 auto; color: #0a0a0a;">
  <h1 style="font-size: 20px; letter-spacing: -0.02em;">Signing complete</h1>
  <p>Hi ${input.recipientName}, <strong>${input.documentName}</strong> has been signed by everyone.</p>
  <p style="margin: 24px 0;">
    <a href="${input.downloadUrl}" style="background: #be6221; color: #ffffff; padding: 12px 20px; border-radius: 8px; text-decoration: none; font-weight: 600;">View signed document</a>
  </p>
  <p style="font-size: 13px; color: #525252;">Or open this link: ${input.downloadUrl}</p>
  <p style="font-size: 12px; color: #737373;">The document carries a verifiable signature, a trusted timestamp, and a provenance trail.</p>
</div>`;

/**
 * Email a party that a document is fully signed. Best-effort: a delivery
 * failure is logged and swallowed so sealing never fails on email.
 */
export const sendCompletionEmail = async (
  input: CompletionEmail,
): Promise<void> => {
  try {
    await notifications.sendEmail({
      to: input.to,
      subject: `Signed: ${input.documentName}`,
      body: renderBody(input),
      html: true,
    });
  } catch (err) {
    console.warn("[signet] completion email failed", err);
  }
};
