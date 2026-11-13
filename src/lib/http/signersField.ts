/**
 * Read the `signers` field of a multipart create request. Clients send it as a
 * JSON string, but Elysia JSON-parses multipart text fields that look like
 * JSON, so the handler can receive either the string or the already-parsed
 * array. Accept both, ignore malformed entries, and never throw: an unusable
 * value is simply no signers, which the caller rejects with a clear error.
 */

export interface SignerField {
  name: string;
  email?: string;
  accessCode?: string;
}

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

export const parseSignersField = (value: unknown): SignerField[] => {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const o = entry as Record<string, unknown>;
    const name = text(o.name);
    if (!name) return [];
    return [{ name, email: text(o.email), accessCode: text(o.accessCode) }];
  });
};
