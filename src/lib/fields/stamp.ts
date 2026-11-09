/**
 * Stamp field values (each signer's adopted signature, initials, date, or text)
 * onto a PDF at their field positions before the cryptographic signature is
 * applied, so the signed document shows the marks where the incumbents place
 * them. Each field carries its own value, so several signers can fill their own
 * fields independently.
 */

import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

export interface StampField {
  /** signature | date | initials | text */
  type: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** the text to draw, empty or null to skip the field */
  value?: string | null;
}

/** Initials from a full name: first letter of each word, uppercased */
export const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

/**
 * Draw each field's value onto the PDF. Signatures and initials use an italic
 * face to read as a signature; dates and text use the regular face. Fields with
 * no value, or on a page the document lacks, are skipped.
 */
export const stampFields = async (
  pdf: Uint8Array,
  fields: StampField[],
): Promise<Uint8Array> => {
  const toDraw = fields.filter((f) => f.value);
  if (toDraw.length === 0) return pdf;

  const doc = await PDFDocument.load(pdf);
  const pages = doc.getPages();
  const script = await doc.embedFont(StandardFonts.HelveticaOblique);
  const plain = await doc.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.11, 0.18, 0.45);

  for (const field of toDraw) {
    const page = pages[field.page - 1];
    const text = field.value;
    if (!page || !text) continue;

    const font =
      field.type === "date" || field.type === "text" ? plain : script;
    let size = Math.min(field.height, 14);
    while (size > 6 && font.widthOfTextAtSize(text, size) > field.width) {
      size -= 0.5;
    }
    page.drawText(text, { x: field.x, y: field.y + 2, size, font, color: ink });
  }

  return doc.save();
};
