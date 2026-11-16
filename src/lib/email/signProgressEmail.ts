import { notifications } from "../providers/index.ts";
import { emailShell, escapeHtml } from "./shell.ts";

export interface SignedReceiptEmail {
  to: string;
  signerName: string;
  documentName: string;
  /** where the signer can see the document with their signature */
  viewUrl: string;
}

export interface SignerProgressEmail {
  to: string;
  signerName: string;
  documentName: string;
  /** names of the signers who still have to sign, in order */
  waitingOn: string[];
  /** where the sender follows the document */
  manageUrl: string;
}

const list = (names: string[]): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

const renderReceipt = (input: SignedReceiptEmail): string =>
  emailShell({
    title: `You signed: ${escapeHtml(input.documentName)}`,
    heading: "Thanks for signing",
    body: `<p style="margin:0;">Hi ${escapeHtml(input.signerName)}, your signature on <strong>${escapeHtml(input.documentName)}</strong> is recorded. You will get the final copy once everyone has signed.</p>`,
    button: { url: input.viewUrl, label: "View document" },
    note: "Nothing else is needed from you.",
  });

const renderProgress = (input: SignerProgressEmail): string =>
  emailShell({
    title: `${escapeHtml(input.signerName)} signed: ${escapeHtml(input.documentName)}`,
    heading: `${escapeHtml(input.signerName)} signed`,
    body: `<p style="margin:0;"><strong>${escapeHtml(input.signerName)}</strong> signed <strong>${escapeHtml(input.documentName)}</strong>.${
      input.waitingOn.length > 0
        ? ` Still waiting on ${escapeHtml(list(input.waitingOn))}.`
        : ""
    }</p>`,
    button: { url: input.manageUrl, label: "View document" },
    note: "You will get the sealed document once everyone has signed.",
  });

/**
 * Confirm to a signer that their signature on a document still awaiting
 * others is recorded. Best-effort: a delivery failure is logged and swallowed
 */
export const sendSignedReceiptEmail = async (
  input: SignedReceiptEmail,
): Promise<void> => {
  try {
    await notifications.sendEmail({
      to: input.to,
      subject: `You signed: ${input.documentName}`,
      body: renderReceipt(input),
      html: true,
    });
  } catch (err) {
    console.warn("[signet] signed-receipt email failed", err);
  }
};

/**
 * Tell the sender that one signer of a document still awaiting others has
 * signed. Best-effort: a delivery failure is logged and swallowed
 */
export const sendSignerProgressEmail = async (
  input: SignerProgressEmail,
): Promise<void> => {
  try {
    await notifications.sendEmail({
      to: input.to,
      subject: `${input.signerName} signed: ${input.documentName}`,
      body: renderProgress(input),
      html: true,
    });
  } catch (err) {
    console.warn("[signet] signer-progress email failed", err);
  }
};
