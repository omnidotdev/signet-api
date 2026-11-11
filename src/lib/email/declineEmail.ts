import { notifications } from "../providers/index.ts";

export interface DeclineEmail {
  to: string;
  documentName: string;
  signerName: string;
  /** the reason the signer gave, if any */
  reason?: string | null;
  /** where the sender can review the document */
  manageUrl: string;
}

// Token values inlined as literal hex (email clients ignore CSS variables), to
// match the app's Sigil-token styling: citrine accent #be6221, fg #0a0a0a /
// #525252 / #737373, radius-lg 8px
const renderBody = (input: DeclineEmail): string => `
<div style="font-family: ui-sans-serif, system-ui, sans-serif; max-width: 480px; margin: 0 auto; color: #0a0a0a;">
  <h1 style="font-size: 20px; letter-spacing: -0.02em;">A signer declined</h1>
  <p><strong>${input.signerName}</strong> declined to sign <strong>${input.documentName}</strong>, so the document has been voided and can no longer be signed.</p>
  ${
    input.reason
      ? `<p style="background: #f5f5f5; border-radius: 8px; padding: 12px 16px; font-size: 14px;">Reason given: ${input.reason}</p>`
      : ""
  }
  <p style="margin: 24px 0;">
    <a href="${input.manageUrl}" style="background: #be6221; color: #ffffff; padding: 12px 20px; border-radius: 8px; text-decoration: none; font-weight: 600;">Review in Signet</a>
  </p>
  <p style="font-size: 12px; color: #737373;">You can start a new request whenever you are ready.</p>
</div>`;

/**
 * Email the sender that a signer declined and the document was voided.
 * Best-effort: a delivery failure is logged and swallowed.
 */
export const sendDeclineEmail = async (input: DeclineEmail): Promise<void> => {
  try {
    await notifications.sendEmail({
      to: input.to,
      subject: `Declined: ${input.documentName}`,
      body: renderBody(input),
      html: true,
    });
  } catch (err) {
    console.warn("[signet] decline email failed", err);
  }
};
