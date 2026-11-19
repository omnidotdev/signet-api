import { createHmac, timingSafeEqual } from "node:crypto";
import { Elysia, t } from "elysia";
import type { Db } from "../db/client.ts";
import type { WorkspaceDeletionResult } from "../documents/workspaceDeletion.ts";
import { deleteWorkspaceData } from "../documents/workspaceDeletion.ts";

/** Constant-time check of a hex HMAC-SHA256 signature over the raw body */
const verifySignature = (
  payload: string,
  signature: string,
  secret: string,
): boolean => {
  try {
    const expected = createHmac("sha256", secret).update(payload).digest("hex");
    const a = Buffer.from(signature, "hex");
    const b = Buffer.from(expected, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
};

export interface IdpWebhookRoutesDeps {
  /** Database handle, resolved per request so the module loads without one */
  getDb: () => Db;
  /**
   * Shared secret Vortex signs identity events with (IDP_WEBHOOK_SECRET). When
   * unset every request is refused (fail closed)
   */
  webhookSecret: string | undefined;
  /**
   * Tell signers still holding a live link that their request was canceled,
   * called once the deletion has committed
   */
  notifyCanceled?: (canceled: WorkspaceDeletionResult["canceled"]) => void;
}

/**
 * `POST /webhooks/idp`: Gatekeeper identity events, delivered by Vortex as
 * HMAC-signed webhooks (`x-idp-signature`, hex HMAC-SHA256 of the raw body).
 *
 * Handles `organization.deleted`: the deleted workspace's documents and API
 * keys are deleted (see documents/workspaceDeletion), and signers still holding
 * a live link are told their request was canceled. Other events are acked
 * without effect.
 *
 * No secret is a 503, a missing or bad signature a 401, an unreadable body or
 * a missing organization id a 400, and a failed deletion a 500 so Vortex
 * retries it (the deletion is idempotent)
 */
export const createIdpWebhookRoutes = ({
  getDb,
  webhookSecret,
  notifyCanceled,
}: IdpWebhookRoutesDeps) =>
  new Elysia({ name: "idp-webhook-routes" }).post(
    "/webhooks/idp",
    async ({ request, headers, set }) => {
      const rawBody = await request.text();
      const signature = headers["x-idp-signature"];

      if (!webhookSecret) {
        console.warn(
          "IDP_WEBHOOK_SECRET not set, rejecting unverifiable IDP webhook",
        );
        set.status = 503;
        return { error: "Webhook secret not configured" };
      }
      if (!signature) {
        set.status = 401;
        return { error: "Missing signature" };
      }
      if (!verifySignature(rawBody, signature, webhookSecret)) {
        set.status = 401;
        return { error: "Invalid signature" };
      }

      let event: { eventType?: unknown; organizationId?: unknown };
      try {
        event = JSON.parse(rawBody);
      } catch {
        set.status = 400;
        return { error: "Invalid JSON" };
      }

      if (event.eventType !== "organization.deleted") {
        console.warn(
          `[signet] unhandled IDP event type: ${String(event.eventType)}`,
        );
        return { received: true };
      }

      const { organizationId } = event;
      if (typeof organizationId !== "string" || !organizationId) {
        set.status = 400;
        return { error: "Missing organizationId" };
      }

      try {
        const result = await deleteWorkspaceData(getDb(), organizationId);
        notifyCanceled?.(result.canceled);
        console.info(
          `[signet] organization.deleted for ${organizationId}: deleted ${result.documents} documents and ${result.apiKeys} API keys`,
        );
      } catch (err) {
        console.error(
          `[signet] organization.deleted for ${organizationId} failed`,
          err,
        );
        set.status = 500;
        return { error: "Internal Server Error" };
      }

      return { received: true };
    },
    {
      headers: t.Object({
        "x-idp-signature": t.Optional(t.String()),
        "x-idp-event": t.Optional(t.String()),
      }),
      // Read the raw body as text so the signature covers the exact bytes sent
      parse: "none",
    },
  );
