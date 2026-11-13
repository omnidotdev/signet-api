/**
 * Handwriting styles a signer can choose for a typed signature. "classic" is the
 * long-standing oblique sans face (a PDF standard font, nothing to embed); the
 * others are bundled TrueType fonts under permissive licenses (SIL Open Font
 * License or Apache 2.0, see assets/fonts) that allow embedding in documents.
 * A chosen face is embedded subset into the signed PDF, so only the glyphs of
 * the signer's name are carried.
 */

import { readFile } from "node:fs/promises";

import fontkit from "@pdf-lib/fontkit";

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

/**
 * x-height of Helvetica Oblique (AFM XHeight 523 per 1000 em), the face of the
 * classic signature. Handwriting faces are sized to match it
 */
export const CLASSIC_X_HEIGHT_EM = 0.523;

const xHeights = new Map<string, number>();

/**
 * A handwriting face's x-height as a fraction of its em, read from the font's
 * own metrics; null for the classic style or an unknown id. Script faces vary
 * widely (Sacramento's lowercase is about 0.31 em, Homemade Apple's about 0.59)
 * so a shared point size would make some look tiny and others oversized
 */
export const signatureFontXHeight = async (
  id: string | null | undefined,
): Promise<number | null> => {
  const font = signatureFontOrNull(id);
  if (!font) return null;
  const cached = xHeights.get(font);
  if (cached) return cached;
  const bytes = await loadSignatureFont(font);
  if (!bytes) return null;
  const metrics = fontkit.create(bytes) as {
    xHeight: number;
    unitsPerEm: number;
  };
  const xHeightEm = metrics.xHeight / metrics.unitsPerEm;
  xHeights.set(font, xHeightEm);
  return xHeightEm;
};

/**
 * The point size at which a handwriting face's lowercase letters stand as tall
 * as the classic signature's at `classicSize`, so every style reads at the same
 * visual size (optical sizing by x-height)
 */
export const handwritingSize = (
  classicSize: number,
  xHeightEm: number,
): number => (classicSize * CLASSIC_X_HEIGHT_EM) / xHeightEm;
