import { fromAs, notifications } from "../providers/index.ts";
import { emailQuote, emailShell, escapeHtml } from "./shell.ts";

export interface SignatureRequestEmail {
  to: string;
  signerName: string;
  documentName: string;
  signUrl: string;
  /** who sent it, shown in the From name and the greeting */
  senderName?: string | null;
  /** replies go to the sender, not to Signet */
  senderEmail?: string | null;
  /** the sender's note to signers */
  message?: string | null;
  /** when the request stops accepting signatures */
  expiresAt?: Date | null;
  /**
   * "request" when first sent, "reminder" for a nudge, "expiring" for the last
   * reminder before the request expires
   */
  kind?: "request" | "reminder" | "expiring";
}

const longDate = (d: Date): string =>
  d.toLocaleDateString("en-US", { dateStyle: "long", timeZone: "UTC" });

/** One-line header text, never a line break a header could be split on */
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, " ").trim();

export const requestSubject = (input: SignatureRequestEmail): string => {
  const doc = oneLine(input.documentName);
  switch (input.kind) {
    case "reminder":
      return `Reminder: please sign ${doc}`;
    case "expiring":
      return `Expires soon: please sign ${doc}`;
    default:
      return input.senderName
        ? `${oneLine(input.senderName)} sent you ${doc} to sign`
        : `Signature requested: ${doc}`;
  }
};

export const renderRequest = (input: SignatureRequestEmail): string => {
  const doc = `<strong>${escapeHtml(input.documentName)}</strong>`;
  const who = input.senderName ? escapeHtml(input.senderName) : null;
  const lead =
    input.kind === "reminder" || input.kind === "expiring"
      ? `${doc} is still waiting for your signature${who ? ` (sent by ${who})` : ""}.`
      : who
        ? `${who} sent you ${doc} to review and sign.`
        : `${doc} is ready for your signature.`;
  const deadline = input.expiresAt
    ? ` Please sign by <strong>${longDate(input.expiresAt)}</strong>${
        input.kind === "expiring" ? ", when this request expires" : ""
      }.`
    : "";
  return emailShell({
    title: escapeHtml(requestSubject(input)),
    heading:
      input.kind === "expiring"
        ? "This request expires soon"
        : input.kind === "reminder"
          ? "A document is waiting for your signature"
          : "You have a document to sign",
    body: `<p style="margin:0;">Hi ${escapeHtml(input.signerName)}, ${lead}${deadline}</p>${
      input.message
        ? emailQuote(
            `Message from ${who ?? "the sender"}:`,
            escapeHtml(input.message).replace(/\n/g, "<br>"),
          )
        : ""
    }`,
    button: { url: input.signUrl, label: "Review and sign" },
    note: input.senderEmail
      ? "Questions about this document? Reply to this email to reach the sender."
      : "Signed documents carry a verifiable signature and a provenance trail.",
  });
};

/**
 * Email a signer their signing link (first send, reminder, or last reminder).
 * Best-effort: a delivery failure is logged and swallowed so creating the
 * signing request never fails on email
 */
export const sendSignatureRequestEmail = async (
  input: SignatureRequestEmail,
): Promise<void> => {
  try {
    await notifications.sendEmail({
      to: input.to,
      subject: requestSubject(input),
      body: renderRequest(input),
      html: true,
      ...(input.senderName
        ? { from: fromAs(`${input.senderName} via Signet`) }
        : {}),
      ...(input.senderEmail ? { replyTo: input.senderEmail } : {}),
    });
  } catch (err) {
    console.warn("[signet] signature-request email failed", err);
  }
};
