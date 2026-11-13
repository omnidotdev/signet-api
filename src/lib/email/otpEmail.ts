import { OTP_TTL_MS } from "../documents/otp.ts";
import { notifications } from "../providers/index.ts";
import { emailShell, escapeHtml } from "./shell.ts";

export interface OtpEmail {
  to: string;
  signerName: string;
  documentName: string;
  code: string;
}

const minutes = Math.round(OTP_TTL_MS / 60000);

const renderBody = (input: OtpEmail): string =>
  emailShell({
    title: `Your verification code: ${input.code}`,
    heading: "Verify your identity to sign",
    body: `<p style="margin:0;">Hi ${escapeHtml(input.signerName)}, enter this code to open <strong>${escapeHtml(input.documentName)}</strong> for signing:</p>
      <div style="margin:24px 0 4px;font-size:34px;font-weight:800;letter-spacing:0.22em;color:#1b1613;font-family:'SFMono-Regular',ui-monospace,Menlo,Consolas,monospace;">${escapeHtml(input.code)}</div>
      <p style="margin:12px 0 0;font-size:13px;color:#6c6158;">This code expires in ${minutes} minutes. If you did not request it, you can ignore this email.</p>`,
    note: "Signet asks for this code to confirm it is really you before you sign.",
  });

/**
 * Email a signer their one-time verification code. Best-effort: a delivery
 * failure is logged and swallowed, but the caller should treat email as the
 * only channel and not reveal the code anywhere else
 */
export const sendOtpEmail = async (input: OtpEmail): Promise<void> => {
  try {
    await notifications.sendEmail({
      to: input.to,
      subject: `Your Signet verification code: ${input.code}`,
      body: renderBody(input),
      html: true,
    });
  } catch (err) {
    console.warn("[signet] verification-code email failed", err);
  }
};
