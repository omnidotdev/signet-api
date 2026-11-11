import { notifications } from "../providers/index.ts";
import { emailQuote, emailShell, escapeHtml } from "./shell.ts";

export interface DeclineEmail {
  to: string;
  documentName: string;
  signerName: string;
  /** the reason the signer gave, if any */
  reason?: string | null;
  /** where the sender can review the document */
  manageUrl: string;
}

const renderBody = (input: DeclineEmail): string =>
  emailShell({
    title: `Declined: ${input.documentName}`,
    heading: "A signer declined",
    body:
      `<p style="margin:0;"><strong>${escapeHtml(input.signerName)}</strong> declined to sign <strong>${escapeHtml(input.documentName)}</strong>, so it has been voided and can no longer be signed.</p>` +
      (input.reason ? emailQuote("Reason:", escapeHtml(input.reason)) : ""),
    button: { url: input.manageUrl, label: "Review in Signet" },
    note: "You can start a new request whenever you are ready.",
  });

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
