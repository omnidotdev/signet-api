import { notifications } from "../providers/index.ts";
import { emailShell, escapeHtml } from "./shell.ts";

export interface CompletionEmail {
  to: string;
  recipientName: string;
  documentName: string;
  /** where this recipient can view and download the finished document */
  downloadUrl: string;
}

const renderBody = (input: CompletionEmail): string =>
  emailShell({
    title: `Signed: ${input.documentName}`,
    heading: "Signing complete",
    body: `<p style="margin:0;">Hi ${escapeHtml(input.recipientName)}, <strong>${escapeHtml(input.documentName)}</strong> has been signed by everyone.</p>`,
    button: { url: input.downloadUrl, label: "View signed document" },
    note: "The document carries a verifiable signature, a trusted timestamp, and a provenance trail.",
  });

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
