// Email clients ignore CSS custom properties, so the Sigil token values are
// inlined here as literal hex. These mirror the app's citrine (#be6221) brand
// on a warm neutral ground, and are the single source of truth for the look of
// every Signet notification.
const BRAND = "#be6221";
const BG = "#f7f3f0";
const CARD = "#ffffff";
const BORDER = "#ece4dd";
const FG = "#1b1613";
const MUTED = "#6c6158";
const FAINT = "#9a8f85";
const QUOTE_BG = "#faf6f3";

/** Escape user-supplied text before interpolating it into email HTML */
export const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export interface EmailButton {
  url: string;
  label: string;
}

/** A soft callout block, e.g. for the reason a signer declined */
export const emailQuote = (label: string, value: string): string => `
      <div style="margin:18px 0 0;background:${QUOTE_BG};border:1px solid ${BORDER};border-left:3px solid ${BRAND};border-radius:10px;padding:12px 16px;font-size:14px;line-height:1.55;color:${MUTED};">
        <strong style="color:${FG};">${label}</strong> ${value}
      </div>`;

/**
 * The shared Signet email layout: a warm, branded card used by every Signet
 * notification, so they read as one product. `body` is trusted inner HTML the
 * caller assembles (escaping any user values with `escapeHtml`); `note` is a
 * small reassurance line under the card.
 */
export const emailShell = ({
  title,
  heading,
  body,
  button,
  note,
}: {
  title: string;
  heading: string;
  body: string;
  button?: EmailButton;
  note?: string;
}): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:${BG};">
  <div style="max-width:540px;margin:0 auto;padding:40px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="padding:0 4px 20px;">
      <span style="font-size:19px;font-weight:800;letter-spacing:-0.02em;color:${BRAND};">Signet</span>
    </div>
    <div style="background:${CARD};border:1px solid ${BORDER};border-radius:18px;padding:36px 32px;box-shadow:0 1px 2px rgba(27,22,19,0.04);">
      <h1 style="margin:0 0 14px;font-size:21px;line-height:1.3;letter-spacing:-0.02em;color:${FG};">${heading}</h1>
      <div style="font-size:15px;line-height:1.65;color:${FG};">${body}</div>${
        button
          ? `
      <div style="margin:28px 0 0;">
        <a href="${button.url}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 28px;border-radius:999px;">${button.label}</a>
      </div>
      <p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:${FAINT};">Or paste this link into your browser:<br><span style="color:${MUTED};word-break:break-all;">${button.url}</span></p>`
          : ""
      }
    </div>${
      note
        ? `
    <p style="margin:18px 4px 0;font-size:12px;line-height:1.6;color:${MUTED};">${note}</p>`
        : ""
    }
    <p style="margin:12px 4px 0;font-size:11px;line-height:1.6;color:${FAINT};">Signet &middot; Secure e-signatures by Omni</p>
  </div>
</body>
</html>`;
