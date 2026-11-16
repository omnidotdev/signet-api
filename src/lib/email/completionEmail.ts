import type { EmailAttachment } from "@omnidotdev/providers/notifications";

import { notifications } from "../providers/index.ts";
import { emailShell, escapeHtml } from "./shell.ts";

export interface CompletionEmail {
  to: string;
  recipientName: string;
  documentName: string;
  /** where this recipient can view and download the finished document */
  downloadUrl: string;
}

/** The finished files to attach: the sealed PDF and its certificate */
export interface CompletionFiles {
  signedPdf: Uint8Array;
  certificatePdf: Uint8Array | null;
}

const renderBody = (input: CompletionEmail, attached: boolean): string =>
  emailShell({
    title: `Signed: ${escapeHtml(input.documentName)}`,
    heading: "Signing complete",
    body: `<p style="margin:0;">Hi ${escapeHtml(input.recipientName)}, <strong>${escapeHtml(input.documentName)}</strong> has been signed by everyone.${
      attached
        ? " The signed document and its Certificate of Completion are attached."
        : ""
    }</p>`,
    button: { url: input.downloadUrl, label: "View signed document" },
    note: "The document carries a verifiable signature, a trusted timestamp, and a provenance trail.",
  });

/**
 * A file name from the document's title: no folder separators (the mail
 * service would read them as a path) and no doubled extension
 */
const fileBase = (title: string): string =>
  title
    .replace(/\.(pdf|docx|png|jpe?g)$/i, "")
    .replace(/[\\/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "document";

/** The attachments for a finished document */
export const completionAttachments = (
  documentName: string,
  files: CompletionFiles,
): EmailAttachment[] => {
  const base = fileBase(documentName);
  return [
    {
      filename: `${base}.pdf`,
      content: files.signedPdf,
      contentType: "application/pdf",
    },
    ...(files.certificatePdf
      ? [
          {
            filename: `${base} certificate.pdf`,
            content: files.certificatePdf,
            contentType: "application/pdf",
          },
        ]
      : []),
  ];
};

/**
 * Email a party that a document is fully signed, with the signed PDF and its
 * certificate attached when available. If the attached send is refused (for
 * example a document too large to attach), the email goes out again with the
 * link only, so nobody misses the notice. Best-effort: a delivery failure is
 * logged and swallowed so sealing never fails on email.
 */
export const sendCompletionEmail = async (
  input: CompletionEmail,
  files?: CompletionFiles | null,
): Promise<void> => {
  const send = (attached: boolean) =>
    notifications.sendEmail({
      to: input.to,
      subject: `Signed: ${input.documentName}`,
      body: renderBody(input, attached),
      html: true,
      ...(attached && files
        ? { attachments: completionAttachments(input.documentName, files) }
        : {}),
    });
  try {
    if (files) {
      const result = await send(true);
      if (result.success) return;
      console.warn(
        "[signet] completion email with attachments refused, sending the link only",
        result.error,
      );
    }
    const result = await send(false);
    if (!result.success)
      console.warn("[signet] completion email failed", result.error);
  } catch (err) {
    console.warn("[signet] completion email failed", err);
  }
};
