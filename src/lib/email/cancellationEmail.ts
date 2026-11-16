import { notifications } from "../providers/index.ts";
import { emailShell, escapeHtml } from "./shell.ts";

export interface CancellationEmail {
  to: string;
  signerName: string;
  documentName: string;
  /**
   * why: the sender withdrew it, another signer declined, the sender removed
   * this signer (or moved the request to another address), or it expired
   */
  reason: "withdrawn" | "declined" | "removed" | "expired";
}

const REASON_TEXT: Record<CancellationEmail["reason"], string> = {
  withdrawn: "was canceled by the sender",
  declined: "was canceled because another signer declined it",
  removed: "is no longer addressed to you; the sender removed you from it",
  expired: "expired before it was signed",
};

const renderBody = (input: CancellationEmail): string =>
  emailShell({
    title: `${input.reason === "expired" ? "Expired" : "Canceled"}: ${escapeHtml(input.documentName)}`,
    heading:
      input.reason === "expired"
        ? "This signature request expired"
        : "This signature request was canceled",
    body: `<p style="margin:0;">Hi ${escapeHtml(input.signerName)}, the request to sign <strong>${escapeHtml(input.documentName)}</strong> ${REASON_TEXT[input.reason]}. The link in the earlier email no longer works, and there is nothing you need to do.</p>`,
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
      subject: `${input.reason === "expired" ? "Expired" : "Canceled"}: ${input.documentName}`,
      body: renderBody(input),
      html: true,
    });
  } catch (err) {
    console.warn("[signet] cancellation email failed", err);
  }
};
