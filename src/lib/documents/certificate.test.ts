import { describe, expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import type { CertificateData } from "./certificate.ts";
import { buildCompletionCertificate } from "./certificate.ts";

const sample = (over: Partial<CertificateData> = {}): CertificateData => ({
  documentName: "TopCrush Operating Agreement",
  documentId: "doc-123",
  contentHash: "a".repeat(64),
  createdAt: "2026-11-01T10:00:00.000Z",
  completedAt: "2026-11-02T14:30:00.000Z",
  provenanceValid: true,
  trustedTimestamp: { genTime: "2026-11-02T14:30:05.000Z", tsa: "Example TSA" },
  signers: [
    {
      name: "Ada Lovelace",
      email: "ada@example.com",
      signedAt: "2026-11-02T12:00:00.000Z",
      consent: true,
      ip: "203.0.113.7",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      verification: {
        method: "email_otp",
        verifiedAt: "2026-11-02T11:58:00.000Z",
      },
    },
    {
      name: "Grace Hopper",
      email: "grace@example.com",
      signedAt: "2026-11-02T14:30:00.000Z",
      consent: true,
      ip: "198.51.100.42",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      verification: null,
    },
  ],
  events: [
    {
      type: "document.created",
      timestamp: "2026-11-01T10:00:00.000Z",
      signer: null,
    },
    {
      type: "document.sent",
      timestamp: "2026-11-01T10:05:00.000Z",
      signer: null,
    },
    {
      type: "document.signed",
      timestamp: "2026-11-02T12:00:00.000Z",
      signer: "Ada Lovelace",
    },
    {
      type: "document.signed",
      timestamp: "2026-11-02T14:30:00.000Z",
      signer: "Grace Hopper",
    },
    {
      type: "document.completed",
      timestamp: "2026-11-02T14:30:00.000Z",
      signer: null,
    },
  ],
  ...over,
});

describe("certificate of completion", () => {
  test("builds a valid, non-trivial PDF", async () => {
    const bytes = await buildCompletionCertificate(sample());
    expect(bytes.length).toBeGreaterThan(1000);
    // a real PDF starts with the %PDF- header
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const parsed = await PDFDocument.load(bytes);
    expect(parsed.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  test("handles a long signer list by paginating", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      name: `Signer Number ${i + 1}`,
      email: `signer${i + 1}@example.com`,
      signedAt: "2026-11-02T12:00:00.000Z",
      consent: true,
      ip: "203.0.113.7",
      userAgent: "Mozilla/5.0 (TestAgent)",
      verification: null,
    }));
    const bytes = await buildCompletionCertificate(sample({ signers: many }));
    const parsed = await PDFDocument.load(bytes);
    expect(parsed.getPageCount()).toBeGreaterThan(1);
  });

  test("renders without a trusted timestamp or content hash", async () => {
    const bytes = await buildCompletionCertificate(
      sample({ trustedTimestamp: null, contentHash: null }),
    );
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  test("renders when a signer has no captured IP or user-agent", async () => {
    const bytes = await buildCompletionCertificate(
      sample({
        signers: [
          {
            name: "Ada Lovelace",
            email: "ada@example.com",
            signedAt: "2026-11-02T12:00:00.000Z",
            consent: true,
            ip: null,
            userAgent: null,
            verification: null,
          },
        ],
      }),
    );
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  test("renders a signer verified by a one-time code", async () => {
    const bytes = await buildCompletionCertificate(
      sample({
        signers: [
          {
            name: "Ada Lovelace",
            email: "ada@example.com",
            signedAt: "2026-11-02T12:00:00.000Z",
            consent: true,
            ip: "203.0.113.7",
            userAgent: "Mozilla/5.0 (TestAgent)",
            verification: {
              method: "email_otp",
              verifiedAt: "2026-11-02T11:58:00.000Z",
            },
          },
        ],
      }),
    );
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });
});
