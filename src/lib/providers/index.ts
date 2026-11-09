import { createNotificationProvider } from "@omnidotdev/providers/notifications";

const { HERALD_API_URL, HERALD_API_KEY, SIGNET_FROM_EMAIL } = process.env;

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
        defaultFrom: SIGNET_FROM_EMAIL ?? "signatures@send.omni.dev",
      }
    : {},
);

if (!HERALD_API_URL || !HERALD_API_KEY) {
  console.warn(
    "HERALD_API_URL/HERALD_API_KEY not set, signing-link emails disabled (links still returned)",
  );
}
