import type { PDFFont } from "pdf-lib";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

/** One signer's outcome, as it appears on the certificate */
export interface CertificateSigner {
  name: string;
  email: string | null;
  /** ISO 8601 time the signer completed, or null if not yet signed */
  signedAt: string | null;
  /** whether the signer affirmed the electronic-records (ESIGN / UETA) consent */
  consent: boolean;
}

/** Everything the certificate of completion renders, assembled from the ledger */
export interface CertificateData {
  documentName: string;
  documentId: string;
  /** SHA-256 fingerprint of the original document content, if recorded */
  contentHash: string | null;
  /** ISO 8601 time the request was created */
  createdAt: string;
  /** ISO 8601 time the document completed, if it has */
  completedAt: string | null;
  /** whether the tamper-evident provenance chain verifies */
  provenanceValid: boolean;
  /** the TSA-asserted trusted timestamp on the sealed document, if any */
  trustedTimestamp: { genTime: string | null; tsa: string } | null;
  signers: CertificateSigner[];
  /** the ordered audit trail */
  events: { type: string; timestamp: string; signer: string | null }[];
}

const INK = rgb(0.11, 0.13, 0.2);
const MUTED = rgb(0.42, 0.45, 0.52);
const LINE = rgb(0.85, 0.86, 0.9);
const ACCENT = rgb(0.11, 0.18, 0.45);

const MARGIN = 56;
const PAGE_W = 612;
const PAGE_H = 792;

const EVENT_LABEL: Record<string, string> = {
  "document.created": "Created",
  "document.sent": "Sent for signature",
  "document.viewed": "Opened by a signer",
  "document.signed": "Signed",
  "signature.completed": "Signed",
  "document.completed": "Completed and sealed",
  "document.declined": "Declined",
  "document.voided": "Voided",
};

const labelFor = (type: string) =>
  EVENT_LABEL[type] ?? type.replace(/^[a-z]+\./, "").replace(/[._]/g, " ");

/** Format an ISO timestamp as a stable, human-readable UTC string */
const fmt = (iso: string | null): string => {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} UTC`;
};

/**
 * Build a self-contained Certificate of Completion PDF from a document's
 * provenance ledger: the parties, when each signed, their electronic consent,
 * the document fingerprint, the trusted timestamp, and the full audit trail.
 *
 * This is a separate artifact from the signed PDF (which must not be modified
 * after sealing). It gives senders and signers a court-ready summary of who
 * signed what, when, and under what consent.
 */
export const buildCompletionCertificate = async (
  data: CertificateData,
): Promise<Uint8Array> => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const newPage = () => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };
  const ensure = (needed: number) => {
    if (y - needed < MARGIN) newPage();
  };
  const text = (
    s: string,
    x: number,
    size: number,
    f: PDFFont,
    color = INK,
  ) => {
    page.drawText(s, { x, y, size, font: f, color });
  };
  const rule = () => {
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_W - MARGIN, y },
      thickness: 1,
      color: LINE,
    });
  };
  // wrap a string to a width in a given font/size
  const wrap = (s: string, size: number, f: PDFFont, maxW: number) => {
    const words = s.split(/\s+/);
    const lines: string[] = [];
    let line = "";
    for (const w of words) {
      const trial = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(trial, size) > maxW && line) {
        lines.push(line);
        line = w;
      } else {
        line = trial;
      }
    }
    if (line) lines.push(line);
    return lines;
  };

  // Header
  text("Certificate of Completion", MARGIN, 22, bold, ACCENT);
  y -= 30;
  text("Signet provenance record", MARGIN, 11, font, MUTED);
  y -= 24;
  rule();
  y -= 24;

  // Document block
  text("DOCUMENT", MARGIN, 9, bold, MUTED);
  y -= 16;
  for (const line of wrap(data.documentName, 15, bold, PAGE_W - 2 * MARGIN)) {
    text(line, MARGIN, 15, bold);
    y -= 19;
  }
  y -= 4;
  const metaRow = (label: string, value: string) => {
    ensure(16);
    text(label, MARGIN, 10, font, MUTED);
    text(value, MARGIN + 150, 10, font);
    y -= 16;
  };
  metaRow("Document ID", data.documentId);
  metaRow("Created", fmt(data.createdAt));
  metaRow("Completed", fmt(data.completedAt));
  metaRow(
    "Integrity",
    data.provenanceValid
      ? "Provenance chain verified"
      : "Provenance chain could not be verified",
  );
  if (data.contentHash) {
    metaRow("Fingerprint (SHA-256)", "");
    y += 16; // draw hash on its own wrapped lines under the label
    for (const line of wrap(
      data.contentHash,
      9,
      font,
      PAGE_W - 2 * MARGIN - 150,
    )) {
      text(line, MARGIN + 150, 9, font, INK);
      y -= 13;
    }
    y -= 3;
  }
  if (data.trustedTimestamp?.tsa) {
    metaRow(
      "Trusted timestamp",
      data.trustedTimestamp.genTime
        ? fmt(data.trustedTimestamp.genTime)
        : "present",
    );
    metaRow("Timestamp authority", data.trustedTimestamp.tsa);
  }

  y -= 12;
  rule();
  y -= 24;

  // Signers
  text("SIGNERS", MARGIN, 9, bold, MUTED);
  y -= 20;
  for (const s of data.signers) {
    ensure(58);
    for (const line of wrap(s.name, 12, bold, PAGE_W - 2 * MARGIN)) {
      text(line, MARGIN, 12, bold);
      y -= 15;
    }
    if (s.email) {
      text(s.email, MARGIN, 10, font, MUTED);
      y -= 15;
    }
    text(
      s.signedAt ? `Signed ${fmt(s.signedAt)}` : "Not yet signed",
      MARGIN,
      10,
      font,
      s.signedAt ? INK : MUTED,
    );
    y -= 14;
    text(
      s.consent
        ? "Agreed to sign electronically (ESIGN / UETA)"
        : "Electronic consent not recorded",
      MARGIN,
      9,
      font,
      MUTED,
    );
    y -= 22;
  }

  y -= 2;
  rule();
  y -= 24;

  // Audit trail
  ensure(40);
  text("AUDIT TRAIL", MARGIN, 9, bold, MUTED);
  y -= 20;
  for (const e of data.events) {
    ensure(16);
    const label = e.signer
      ? `${labelFor(e.type)} - ${e.signer}`
      : labelFor(e.type);
    text(fmt(e.timestamp), MARGIN, 9, font, MUTED);
    for (const line of wrap(label, 10, font, PAGE_W - 2 * MARGIN - 160).slice(
      0,
      2,
    )) {
      text(line, MARGIN + 160, 10, font);
      y -= 14;
    }
  }

  // Footer on every page
  const pages = pdf.getPages();
  const generated = fmt(new Date().toISOString());
  pages.forEach((p, i) => {
    p.drawText(
      `Generated by Signet - ${generated} - page ${i + 1} of ${pages.length}`,
      { x: MARGIN, y: 32, size: 8, font, color: MUTED },
    );
  });

  return pdf.save();
};
