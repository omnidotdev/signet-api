/**
 * Accept the common document formats senders upload and normalize them to a PDF
 * before the rest of the pipeline (field detection, stamping, signing) runs. A
 * PDF passes through untouched; a PNG or JPEG is placed onto a page; a DOCX is
 * converted through the headless office converter. An unrecognized format is
 * rejected so the caller can return a clean error rather than storing junk.
 *
 * Detection is by magic bytes, not the browser-supplied MIME type or extension,
 * since those are easily wrong or spoofed.
 */

import { PDFDocument } from "pdf-lib";

import { convertOfficeToPdf, isOfficeConverterAvailable } from "./office.ts";

/** Thrown when an upload is not a format we can turn into a PDF */
export class UnsupportedUploadError extends Error {
  readonly code = "unsupported_format";
  constructor(detail?: string) {
    super(detail ?? "unsupported upload format");
    this.name = "UnsupportedUploadError";
  }
}

const startsWith = (bytes: Uint8Array, sig: number[]): boolean =>
  sig.every((b, i) => bytes[i] === b);

export const isPdf = (b: Uint8Array): boolean =>
  startsWith(b, [0x25, 0x50, 0x44, 0x46]); // %PDF
export const isPng = (b: Uint8Array): boolean =>
  startsWith(b, [0x89, 0x50, 0x4e, 0x47]); // .PNG
export const isJpeg = (b: Uint8Array): boolean =>
  startsWith(b, [0xff, 0xd8, 0xff]);
/** DOCX and other OOXML files are ZIP archives, which start with "PK\x03\x04" */
export const isZip = (b: Uint8Array): boolean =>
  startsWith(b, [0x50, 0x4b, 0x03, 0x04]);

// a Letter-portrait page with a small margin, the image scaled to fit (never
// upscaled) and centered, so the result reads like a normal document page
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 36;

/** Place a single raster image onto one Letter-portrait PDF page */
export const imageToPdf = async (
  bytes: Uint8Array,
  kind: "png" | "jpeg",
): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const img =
    kind === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const maxW = PAGE_W - MARGIN * 2;
  const maxH = PAGE_H - MARGIN * 2;
  const scale = Math.min(maxW / img.width, maxH / img.height, 1);
  const w = img.width * scale;
  const h = img.height * scale;
  page.drawImage(img, {
    x: (PAGE_W - w) / 2,
    y: (PAGE_H - h) / 2,
    width: w,
    height: h,
  });
  return doc.save();
};

/**
 * Normalize an uploaded file to PDF bytes. Returns the input unchanged when it is
 * already a PDF. Throws UnsupportedUploadError for a format we cannot convert
 * (including a DOCX when the office converter is not installed in this image).
 */
export const ensurePdf = async (
  bytes: Uint8Array,
  filename?: string,
): Promise<Uint8Array> => {
  if (isPdf(bytes)) return bytes;
  if (isPng(bytes)) return imageToPdf(bytes, "png");
  if (isJpeg(bytes)) return imageToPdf(bytes, "jpeg");
  if (isZip(bytes) && filename?.toLowerCase().endsWith(".docx")) {
    if (!isOfficeConverterAvailable())
      throw new UnsupportedUploadError("docx conversion not available");
    return convertOfficeToPdf(bytes, "docx");
  }
  throw new UnsupportedUploadError();
};
