/**
 * Handwriting styles a signer can choose for a typed signature. "classic" is the
 * long-standing oblique sans face (a PDF standard font, nothing to embed); the
 * others are bundled TrueType fonts under permissive licenses (SIL Open Font
 * License or Apache 2.0, see assets/fonts) that allow embedding in documents.
 * A chosen face is embedded subset into the signed PDF, so only the glyphs of
 * the signer's name are carried.
 */

import { readFile } from "node:fs/promises";

export const SIGNATURE_FONTS = [
  "classic",
  "sacramento",
  "dafoe",
  "homemade",
] as const;
export type SignatureFont = (typeof SIGNATURE_FONTS)[number];

/** The bundled file for each handwriting style ("classic" has none) */
const FONT_FILES: Record<Exclude<SignatureFont, "classic">, string> = {
  sacramento: "Sacramento-Regular.ttf",
  dafoe: "MrDafoe-Regular.ttf",
  homemade: "HomemadeApple-Regular.ttf",
};

export const isSignatureFont = (value: unknown): value is SignatureFont =>
  typeof value === "string" &&
  (SIGNATURE_FONTS as readonly string[]).includes(value);

/**
 * Normalize a client-supplied style to what is stored: a known handwriting
 * style, or null for the classic default (and for anything unrecognized, so an
 * arbitrary string can never reach the font loader)
 */
export const signatureFontOrNull = (
  value: unknown,
): Exclude<SignatureFont, "classic"> | null =>
  isSignatureFont(value) && value !== "classic" ? value : null;

const cache = new Map<string, Uint8Array>();

/**
 * The TrueType bytes for a handwriting style, read once and cached; null for
 * the classic style or an unknown id
 */
export const loadSignatureFont = async (
  id: string | null | undefined,
): Promise<Uint8Array | null> => {
  const font = signatureFontOrNull(id);
  if (!font) return null;
  const cached = cache.get(font);
  if (cached) return cached;
  const url = new URL(
    `../../../assets/fonts/${FONT_FILES[font]}`,
    import.meta.url,
  );
  const bytes = new Uint8Array(await readFile(url));
  cache.set(font, bytes);
  return bytes;
};
