import { OTP_LENGTH } from "../documents/otp.ts";
import { shell } from "./pages.ts";

const esc = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export interface SignerOtpPageOptions {
  token: string;
  /** the masked address the code was sent to, shown for reassurance */
  maskedEmail: string | null;
  /** an error to surface above the form (e.g. a wrong or expired code) */
  error?: string | null;
}

/**
 * The identity-verification interstitial shown before a protected document's
 * fill page. The signer enters the one-time code emailed to them; the form
 * posts to the verify route, which redirects to the fill page on success. A
 * second form resends the code. Works without client JavaScript.
 */
export const signerOtpPage = ({
  token,
  maskedEmail,
  error,
}: SignerOtpPageOptions): string => {
  const sentTo = maskedEmail
    ? `We emailed a ${OTP_LENGTH}-digit code to <strong>${esc(maskedEmail)}</strong>.`
    : `We emailed you a ${OTP_LENGTH}-digit code.`;
  return shell(
    "Verify to sign - Signet",
    `<span class="pill">Identity check</span>
<h1 style="margin-top:12px;">Verify it is you</h1>
<p class="sub">${sentTo} Enter it below to open the document for signing.</p>
<div class="card">
  ${error ? `<p class="note" role="alert" style="color:var(--accent-emphasized);margin:0 0 12px;">${esc(error)}</p>` : ""}
  <form method="post" action="/sign/${encodeURIComponent(token)}/otp/verify">
    <div>
      <label for="code">Verification code</label>
      <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code"
        pattern="[0-9]*" maxlength="${OTP_LENGTH}" required autofocus
        style="letter-spacing:0.3em;font-size:1.25rem;font-family:ui-monospace,'SFMono-Regular',monospace;" />
    </div>
    <button type="submit">Verify and continue</button>
  </form>
  <form method="post" action="/sign/${encodeURIComponent(token)}/otp/request" style="margin-top:12px;">
    <button type="submit" class="link">Resend code</button>
  </form>
  <p class="note">The code expires after a few minutes. Did not get it? Check spam, or resend.</p>
</div>`,
  );
};
