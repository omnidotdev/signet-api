import { createEventsProvider } from "@omnidotdev/providers/events";
import { createNotificationProvider } from "@omnidotdev/providers/notifications";

const {
  HERALD_API_URL,
  HERALD_API_KEY,
  SIGNET_FROM_EMAIL,
  VORTEX_API_URL,
  VORTEX_API_KEY,
} = process.env;

/**
 * CloudEvents provider (Vortex). Emits `signet.document.*` / `signet.signature.*`
 * lifecycle events. Falls back to a noop provider when Vortex is not configured,
 * so signing works without it (events are simply not published)
 */
export const events = createEventsProvider(
  VORTEX_API_URL && VORTEX_API_KEY
    ? {
        provider: "http",
        baseUrl: VORTEX_API_URL,
        apiKey: VORTEX_API_KEY,
        source: "omni.signet",
      }
    : {},
);

if (!VORTEX_API_URL || !VORTEX_API_KEY) {
  console.warn(
    "VORTEX_API_URL/VORTEX_API_KEY not set, CloudEvents disabled (signing unaffected)",
  );
}

/** The bare address Signet sends from */
const FROM_ADDRESS = (SIGNET_FROM_EMAIL ?? "signatures@send.omni.dev")
  .replace(/^.*</, "")
  .replace(/>.*$/, "")
  .trim();

/**
 * A From header that shows a display name over Signet's address, e.g.
 * "Ada Lovelace via Signet". Quotes, angle brackets, and line breaks are
 * dropped from the name so it cannot alter the header
 */
export const fromAs = (displayName: string): string => {
  const clean = displayName
    .replace(/["<>\r\n\\]/g, "")
    .trim()
    .slice(0, 80);
  return `${clean || "Signet"} <${FROM_ADDRESS}>`;
};

/**
 * Transactional email provider (Herald). Falls back to a noop provider that
 * logs to stdout when Herald is not configured, so send-for-signature still
 * works without it (links are still returned to the sender)
 */
export const notifications = createNotificationProvider(
  HERALD_API_URL && HERALD_API_KEY
    ? {
        provider: "herald",
        apiUrl: HERALD_API_URL,
        apiKey: HERALD_API_KEY,
        defaultFrom: fromAs("Signet"),
      }
    : {},
);

if (!HERALD_API_URL || !HERALD_API_KEY) {
  console.warn(
    "HERALD_API_URL/HERALD_API_KEY not set, signing-link emails disabled (links still returned)",
  );
}
