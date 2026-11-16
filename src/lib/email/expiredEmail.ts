import { notifications } from "../providers/index.ts";
import { emailShell, escapeHtml } from "./shell.ts";

export interface ExpiredEmail {
  to: string;
  documentName: string;
  /** who signed before it expired, and who did not */
  signed: string[];
  unsigned: string[];
  manageUrl: string;
}

const names = (list: string[]) => escapeHtml(list.join(", "));

const renderBody = (input: ExpiredEmail): string =>
  emailShell({
    title: `Expired: ${escapeHtml(input.documentName)}`,
    heading: "A signature request expired",
    body: `<p style="margin:0;"><strong>${escapeHtml(input.documentName)}</strong> expired before everyone signed.${
      input.unsigned.length > 0 ? ` Not signed: ${names(input.unsigned)}.` : ""
    }${input.signed.length > 0 ? ` Signed: ${names(input.signed)}.` : ""} The signers have been told. To try again, upload it as a new version.</p>`,
    button: { url: input.manageUrl, label: "View document" },
    note: "An expired request can no longer be signed.",
  });

/**
 * Tell the sender a request expired before everyone signed. Best-effort: a
 * delivery failure is logged and swallowed
 */
export const sendExpiredEmail = async (input: ExpiredEmail): Promise<void> => {
  try {
    await notifications.sendEmail({
      to: input.to,
      subject: `Expired: ${input.documentName}`,
      body: renderBody(input),
      html: true,
    });
  } catch (err) {
    console.warn("[signet] expired email failed", err);
  }
};
