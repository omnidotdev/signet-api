import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export interface SampleDocumentOptions {
  title?: string;
  body?: string;
  signerName?: string;
}

/**
 * Build a minimal one-page agreement PDF with a visible signature block.
 *
 * The visible block is drawn page content, independent of the cryptographic
 * signature applied later. It gives the signed output a human-readable mark in
 * addition to the embedded CMS signature
 */
export const createSampleDocument = async (
  options: SampleDocumentOptions = {},
): Promise<Uint8Array> => {
  const title = options.title ?? "Agreement";
  const body =
    options.body ??
    "This document was prepared to demonstrate Signet document signing.";
  const signerName = options.signerName ?? "Signet Signer";

  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  page.drawText(title, { x: 64, y: 712, size: 24, font: bold });
  page.drawText(body, { x: 64, y: 664, size: 12, font, maxWidth: 484 });

  const lineY = 140;
  page.drawLine({
    start: { x: 64, y: lineY },
    end: { x: 320, y: lineY },
    thickness: 1,
    color: rgb(0.1, 0.1, 0.1),
  });
  page.drawText(`Signed by: ${signerName}`, {
    x: 64,
    y: lineY - 20,
    size: 11,
    font,
  });
  page.drawText(`Date: ${new Date().toISOString().slice(0, 10)}`, {
    x: 64,
    y: lineY - 36,
    size: 11,
    font,
  });

  return doc.save();
};
