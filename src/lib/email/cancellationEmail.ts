import { notifications } from "../providers/index.ts";
import { emailShell, escapeHtml } from "./shell.ts";

export interface CancellationEmail {
  to: string;
  signerName: string;
  documentName: string;
  /** why: the sender withdrew it, or another signer declined */
  reason: "withdrawn" | "declined";
}

const renderBody = (input: CancellationEmail): string =>
  emailShell({
    title: `Canceled: ${escapeHtml(input.documentName)}`,
    heading: "This signature request was canceled",
    body: `<p style="margin:0;">Hi ${escapeHtml(input.signerName)}, the request to sign <strong>${escapeHtml(input.documentName)}</strong> ${
      input.reason === "declined"
        ? "was canceled because another signer declined it"
        : "was canceled by the sender"
    }. The link in the earlier email no longer works, and there is nothing you need to do.</p>`,
    note: "If you were expecting to sign this, contact the sender.",
  });

/**
 * Tell a signer that a request they were sent was canceled, so a dead link in
 * their inbox is never a surprise. Best-effort: a delivery failure is logged
 * and swallowed so the cancellation itself never fails on email
 */
export const sendCancellationEmail = async (
  input: CancellationEmail,
): Promise<void> => {
  try {
    await notifications.sendEmail({
      to: input.to,
      subject: `Canceled: ${input.documentName}`,
      body: renderBody(input),
      html: true,
    });
  } catch (err) {
    console.warn("[signet] cancellation email failed", err);
  }
};
