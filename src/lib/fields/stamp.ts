/**
 * Stamp field values (each signer's adopted signature, initials, date, or text)
 * onto a PDF at their field positions before the cryptographic signature is
 * applied, so the signed document shows the marks where the incumbents place
 * them. Each field carries its own value (typed) or image (a drawn signature),
 * so several signers can fill their own fields independently.
 */

import fontkit from "@pdf-lib/fontkit";
import type { PDFFont, RGB } from "pdf-lib";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

import { loadSignatureFont } from "./signatureFonts.ts";

export interface StampField {
  /** signature | date | initials | text | checkbox */
  type: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** the text to draw, empty or null to skip a text/date field */
  value?: string | null;
  /** a drawn signature as PNG bytes, drawn in place of the text when present */
  image?: Uint8Array | null;
  /** for a radio button, its label is options[0] */
  options?: string[] | null;
  /** the sender's chosen ink, as #rrggbb; the default ink is used when unset */
  color?: string | null;
  /**
   * the signer's handwriting style for a typed signature or initials (see
   * signatureFonts); ignored for every other field type and for drawn images
   */
  font?: string | null;
}

/** The default ink every mark uses unless the sender picked a field color */
export const DEFAULT_INK = rgb(0.11, 0.18, 0.45);

const HEX_COLOR = /^#?([0-9a-fA-F]{6})$/;

/**
 * Parse a sender-configured `#rrggbb` field color into a pdf-lib ink, or null
 * when it is absent or malformed, so the caller falls back to the default ink.
 */
export const hexToInk = (hex?: string | null): RGB | null => {
  if (!hex) return null;
  const match = HEX_COLOR.exec(hex.trim());
  if (!match) return null;
  const n = Number.parseInt(match[1] as string, 16);
  return rgb(
    ((n >> 16) & 0xff) / 255,
    ((n >> 8) & 0xff) / 255,
    (n & 0xff) / 255,
  );
};

/** Initials from a full name: first letter of each word, uppercased */
export const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

/** Fit (w,h) into a box preserving aspect, returning the scaled size */
const fit = (
  w: number,
  h: number,
  boxW: number,
  boxH: number,
): { w: number; h: number } => {
  const scale = Math.min(boxW / w, boxH / h, 1);
  return { w: w * scale, h: h * scale };
};

/**
 * Draw each field onto the PDF. A drawn-signature image is embedded and fit into
 * the field box; otherwise the typed value is drawn, italic for signatures and
 * initials, plain for dates and text. Empty fields and missing pages are
 * skipped.
 */
export const stampFields = async (
  pdf: Uint8Array,
  fields: StampField[],
): Promise<Uint8Array> => {
  // radio buttons always draw their circle (filled or empty); everything else
  // draws only when it has a value or image
  const toDraw = fields.filter((f) => f.value || f.image || f.type === "radio");
  if (toDraw.length === 0) return pdf;

  const doc = await PDFDocument.load(pdf);
  doc.registerFontkit(fontkit);
  const pages = doc.getPages();

  // fonts are embedded on first use, so a document only carries the faces it
  // actually draws with (a handwriting signature does not drag in the oblique)
  const embedded = new Map<string, PDFFont>();
  const standard = async (name: StandardFonts): Promise<PDFFont> => {
    let font = embedded.get(name);
    if (!font) {
      font = await doc.embedFont(name);
      embedded.set(name, font);
    }
    return font;
  };
  const plain = () => standard(StandardFonts.Helvetica);
  const script = () => standard(StandardFonts.HelveticaOblique);
  /**
   * The handwriting face for a typed signature, embedded subset so only the
   * glyphs of the name are carried. Null when no style was chosen or the face
   * cannot draw every character of the text (a name outside its character set
   * falls back to the classic oblique rather than rendering missing glyphs)
   */
  const handwriting = async (
    id: string | null | undefined,
    text: string,
  ): Promise<PDFFont | null> => {
    if (!id) return null;
    let font = embedded.get(`hand:${id}`);
    if (!font) {
      const bytes = await loadSignatureFont(id);
      if (!bytes) return null;
      font = await doc.embedFont(bytes, { subset: true });
      embedded.set(`hand:${id}`, font);
    }
    const supported = new Set(font.getCharacterSet());
    for (const ch of text) {
      const cp = ch.codePointAt(0) as number;
      if (ch.trim() && !supported.has(cp)) return null;
    }
    return font;
  };

  for (const field of toDraw) {
    const page = pages[field.page - 1];
    if (!page) continue;

    // each field draws in the sender's chosen ink, or the default when unset
    const ink = hexToInk(field.color) ?? DEFAULT_INK;

    if (field.type === "checkbox") {
      // a ticked box draws a check mark; an unticked box carries no value and
      // was filtered out above, so nothing is drawn for it
      const box = Math.min(field.width, field.height);
      const thickness = Math.max(1.2, box * 0.14);
      const ox = field.x;
      const oy = field.y;
      page.drawLine({
        start: { x: ox + box * 0.18, y: oy + box * 0.5 },
        end: { x: ox + box * 0.42, y: oy + box * 0.26 },
        thickness,
        color: ink,
      });
      page.drawLine({
        start: { x: ox + box * 0.42, y: oy + box * 0.26 },
        end: { x: ox + box * 0.82, y: oy + box * 0.74 },
        thickness,
        color: ink,
      });
      continue;
    }

    if (field.type === "radio") {
      // a radio button: an outlined circle, filled when this option is chosen,
      // with its label drawn beside it
      const r = Math.min(field.height, 12) / 2;
      const cx = field.x + r + 1;
      const cy = field.y + field.height / 2;
      page.drawCircle({
        x: cx,
        y: cy,
        size: r,
        borderColor: ink,
        borderWidth: 1,
      });
      if (field.value) {
        page.drawCircle({ x: cx, y: cy, size: r * 0.5, color: ink });
      }
      const label = field.options?.[0];
      if (label) {
        const size = Math.min(field.height, 11);
        page.drawText(label, {
          x: cx + r + 4,
          y: cy - size * 0.35,
          size,
          font: await plain(),
          color: ink,
        });
      }
      continue;
    }

    if (field.image) {
      const png = await doc.embedPng(field.image);
      const size = fit(png.width, png.height, field.width, field.height + 6);
      page.drawImage(png, {
        x: field.x,
        y: field.y,
        width: size.w,
        height: size.h,
      });
      continue;
    }

    const text = field.value;
    if (!text) continue;
    const isMark = field.type === "signature" || field.type === "initials";
    const hand = isMark ? await handwriting(field.font, text) : null;
    const font = hand ?? (isMark ? await script() : await plain());
    // handwriting faces have tall ascenders and long swashes, so they read at
    // a larger size than the oblique sans in the same box
    let size = hand
      ? Math.min(field.height * 0.8, 26)
      : Math.min(field.height, 14);
    while (size > 6 && font.widthOfTextAtSize(text, size) > field.width) {
      size -= 0.5;
    }
    page.drawText(text, { x: field.x, y: field.y + 2, size, font, color: ink });
  }

  return doc.save();
};
