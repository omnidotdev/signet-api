import { describe, expect, test } from "bun:test";

import {
  ensurePdf,
  imageToPdf,
  isJpeg,
  isPdf,
  isPng,
  isZip,
  UnsupportedUploadError,
} from "./ingest.ts";

// a 1x1 PNG and a 1x1 JPEG, the smallest valid rasters, as base64
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const JPEG_1X1 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==";
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));
const pdfMagic = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // "%PDF-1"

describe("magic-byte detectors", () => {
  test("identify each format and reject the others", () => {
    expect(isPdf(pdfMagic)).toBe(true);
    expect(isPng(bytes(PNG_1X1))).toBe(true);
    expect(isJpeg(bytes(JPEG_1X1))).toBe(true);
    expect(isZip(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(isPng(pdfMagic)).toBe(false);
    expect(isPdf(bytes(PNG_1X1))).toBe(false);
  });
});

describe("imageToPdf", () => {
  test("wraps a PNG into a one-page PDF", async () => {
    const pdf = await imageToPdf(bytes(PNG_1X1), "png");
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(100);
  });

  test("wraps a JPEG into a one-page PDF", async () => {
    const pdf = await imageToPdf(bytes(JPEG_1X1), "jpeg");
    expect(isPdf(pdf)).toBe(true);
  });
});

describe("ensurePdf", () => {
  test("passes an existing PDF through unchanged", async () => {
    const input = pdfMagic;
    expect(await ensurePdf(input)).toBe(input);
  });

  test("converts a PNG upload to a PDF", async () => {
    expect(isPdf(await ensurePdf(bytes(PNG_1X1)))).toBe(true);
  });

  test("converts a JPEG upload to a PDF", async () => {
    expect(isPdf(await ensurePdf(bytes(JPEG_1X1)))).toBe(true);
  });

  test("rejects an unrecognized format", async () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(ensurePdf(junk)).rejects.toBeInstanceOf(
      UnsupportedUploadError,
    );
  });
});
