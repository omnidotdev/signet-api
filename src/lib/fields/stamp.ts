/**
 * Stamp field values (the signer's adopted signature, initials, and the date)
 * onto a PDF at their field positions before the cryptographic signature is
 * applied, so the signed document shows a visible signature and date where the
 * incumbents place them.
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
}

export interface StampValues {
  /** the signer's adopted (typed) signature */
  signature: string;
  /** the date to stamp, formatted for display */
  date: string;
}

/** Initials from a full name: first letter of each word, uppercased */
export const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

/** The text a field renders for the given values */
const fieldText = (type: string, values: StampValues): string => {
  switch (type) {
    case "signature":
      return values.signature;
    case "initials":
      return initialsOf(values.signature);
    case "date":
      return values.date;
    default:
      return "";
  }
};

/**
 * Draw each field's value onto the PDF. Signature and initials use an italic
 * face to read as a signature; the date uses the regular face. Fields on a page
 * the document does not have are skipped.
 */
export const stampFields = async (
  pdf: Uint8Array,
  fields: StampField[],
  values: StampValues,
): Promise<Uint8Array> => {
  if (fields.length === 0) return pdf;

  const doc = await PDFDocument.load(pdf);
  const pages = doc.getPages();
  const script = await doc.embedFont(StandardFonts.HelveticaOblique);
  const plain = await doc.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.11, 0.18, 0.45);

  for (const field of fields) {
    const page = pages[field.page - 1];
    if (!page) continue;
    const text = fieldText(field.type, values);
    if (!text) continue;

    const font = field.type === "date" ? plain : script;
    // fit the text to the field box, capped at a readable size
    let size = Math.min(field.height, 14);
    while (size > 6 && font.widthOfTextAtSize(text, size) > field.width) {
      size -= 0.5;
    }
    page.drawText(text, {
      x: field.x,
      y: field.y + 2,
      size,
      font,
      color: ink,
    });
  }

  return doc.save();
};
