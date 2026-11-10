/**
 * PDF object storage.
 *
 * Documents are large binary blobs. By default they live inline in Postgres as
 * base64 (simple, no extra infra), but with S3-compatible object storage
 * configured (Fractal object storage / Garage / MinIO) the bytes move out of
 * the database and only a storage key is kept on the row.
 *
 * The decision is per-write: `storePdf` uploads to the backend when one is
 * configured and returns an empty inline value plus a key, else returns the
 * base64 inline value and a null key. `loadPdf` reads back from whichever side
 * holds the bytes. Existing rows (all inline) keep working unchanged, so
 * enabling storage is a forward-only transition with no migration of old data.
 *
 * The backend is injectable so the storage path is exercised in tests without a
 * live S3 endpoint.
 */

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const toBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64");
const fromBase64 = (b64: string): Uint8Array =>
  new Uint8Array(Buffer.from(b64, "base64"));

/** A place to put and get PDF bytes by key */
export interface PdfBackend {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

const s3Backend = (): PdfBackend | null => {
  const {
    S3_BUCKET,
    S3_ENDPOINT,
    S3_REGION,
    S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY,
  } = process.env;
  if (!(S3_BUCKET && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY)) return null;

  const s3 = new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION ?? "us-east-1",
    // Garage and MinIO require path-style addressing
    forcePathStyle: true,
    credentials: {
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
    },
  });

  return {
    put: async (key, bytes) => {
      await s3.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
          Body: bytes,
          ContentType: "application/pdf",
        }),
      );
    },
    get: async (key) => {
      const res = await s3.send(
        new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }),
      );
      if (!res.Body) return null;
      return res.Body.transformToByteArray();
    },
  };
};

let backend: PdfBackend | null = s3Backend();

/** Override the storage backend (tests, or an alternate store) */
export const setPdfBackend = (b: PdfBackend | null): void => {
  backend = b;
};

/** Whether PDFs are stored in object storage rather than inline in Postgres */
export const pdfStorageEnabled = (): boolean => backend !== null;

if (!backend) {
  console.warn(
    "S3 storage not set, PDFs stored inline in Postgres as base64 (set S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY to externalize)",
  );
}

/** The object key for a document's original (pre-signature) PDF */
export const originalKey = (documentId: string): string =>
  `documents/${documentId}/original.pdf`;

/** The object key for a document's sealed (signed) PDF */
export const signedKey = (documentId: string): string =>
  `documents/${documentId}/signed.pdf`;

/**
 * The persisted form of a stored PDF: `inline` is the base64 column value
 * (empty when externalized) and `key` is the object key (null when inline).
 */
export interface StoredPdf {
  inline: string;
  key: string | null;
}

/** Store PDF bytes: to object storage when configured, else base64 inline */
export const storePdf = async (
  key: string,
  bytes: Uint8Array,
): Promise<StoredPdf> => {
  if (backend) {
    await backend.put(key, bytes);
    return { inline: "", key };
  }
  return { inline: toBase64(bytes), key: null };
};

/** Read PDF bytes back from whichever side holds them (object storage or inline) */
export const loadPdf = async (
  inline: string,
  key: string | null,
): Promise<Uint8Array> => {
  if (key && backend) {
    const bytes = await backend.get(key);
    if (bytes) return bytes;
  }
  return fromBase64(inline);
};
