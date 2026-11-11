/**
 * Stamp field values (each signer's adopted signature, initials, date, or text)
 * onto a PDF at their field positions before the cryptographic signature is
 * applied, so the signed document shows the marks where the incumbents place
 * them. Each field carries its own value (typed) or image (a drawn signature),
 * so several signers can fill their own fields independently.
 */

import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

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
}

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
  const toDraw = fields.filter((f) => f.value || f.image);
  if (toDraw.length === 0) return pdf;

  const doc = await PDFDocument.load(pdf);
  const pages = doc.getPages();
  const script = await doc.embedFont(StandardFonts.HelveticaOblique);
  const plain = await doc.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.11, 0.18, 0.45);

  for (const field of toDraw) {
    const page = pages[field.page - 1];
    if (!page) continue;

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
    const font =
      field.type === "date" ||
      field.type === "text" ||
      field.type === "dropdown" ||
      field.type === "radio"
        ? plain
        : script;
    let size = Math.min(field.height, 14);
    while (size > 6 && font.widthOfTextAtSize(text, size) > field.width) {
      size -= 0.5;
    }
    page.drawText(text, { x: field.x, y: field.y + 2, size, font, color: ink });
  }

  return doc.save();
};
