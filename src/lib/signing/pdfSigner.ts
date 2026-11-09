import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { P12Signer } from "@signpdf/signer-p12";
import { SignPdf } from "@signpdf/signpdf";
import forge from "node-forge";
import { PDFDocument } from "pdf-lib";

/**
 * Options describing the signature placeholder embedded into a PDF before the
 * detached PKCS#7 (CMS) signature is applied. These values become part of the
 * signature dictionary and are visible to any standards-compliant PDF reader.
 */
export interface SignPdfOptions {
  /** Human-readable reason for signing, stored in the signature dictionary */
  reason?: string;
  /** Signer contact information */
  contactInfo?: string;
  /** Signer display name */
  name?: string;
  /** Signing location */
  location?: string;
  /** Passphrase protecting the PKCS#12 bundle, empty string when unprotected */
  passphrase?: string;
}

const DEFAULT_SIGN_OPTIONS = {
  reason: "Signed with Signet",
  contactInfo: "",
  name: "Signet Signer",
  location: "",
  passphrase: "",
} as const;

/**
 * Apply a detached PKCS#7 digital signature to a PDF using a PKCS#12 bundle.
 *
 * The source document is loaded, a signature placeholder is inserted, and the
 * document is signed over a ByteRange that covers the entire file except the
 * signature bytes themselves. The result is a PAdES-style signed PDF that any
 * compliant reader can validate
 */
export const signPdf = async (
  pdf: Uint8Array,
  pkcs12: Uint8Array,
  options: SignPdfOptions = {},
): Promise<Uint8Array> => {
  const opts = { ...DEFAULT_SIGN_OPTIONS, ...options };

  const pdfDoc = await PDFDocument.load(pdf);

  pdflibAddPlaceholder({
    pdfDoc,
    reason: opts.reason,
    contactInfo: opts.contactInfo,
    name: opts.name,
    location: opts.location,
  });

  // object streams must stay disabled so the ByteRange stays contiguous and the
  // placeholder survives serialization
  const withPlaceholder = await pdfDoc.save({ useObjectStreams: false });

  const signer = new P12Signer(Buffer.from(pkcs12), {
    passphrase: opts.passphrase,
  });

  const signed = await new SignPdf().sign(Buffer.from(withPlaceholder), signer);

  return new Uint8Array(signed);
};

/** Structural summary of a signature extracted from a signed PDF */
export interface PdfSignatureInfo {
  /** The four-element ByteRange covering the signed content */
  byteRange: number[];
  /** Common names of every certificate embedded in the CMS structure */
  certificateCommonNames: string[];
  /** Common name of the signer certificate */
  signerCommonName: string | undefined;
  /** Whether a detached CMS signature structure was found and parsed */
  hasSignature: boolean;
}

const BYTE_RANGE_PATTERN = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/;

const extractCommonName = (
  cert: forge.pki.Certificate,
): string | undefined => {
  const field = cert.subject.getField("CN");
  return field?.value as string | undefined;
};

/**
 * Parse a signed PDF and return a structural summary of its first signature.
 *
 * This verifies that a real detached PKCS#7 signature is embedded over a valid
 * ByteRange and reports the signer identity. Full certificate-chain and digest
 * validation is handled by the provenance verification layer
 */
export const inspectPdfSignature = (pdf: Uint8Array): PdfSignatureInfo => {
  const raw = Buffer.from(pdf).toString("latin1");

  const byteRangeMatch = raw.match(BYTE_RANGE_PATTERN);
  if (!byteRangeMatch) {
    return {
      byteRange: [],
      certificateCommonNames: [],
      signerCommonName: undefined,
      hasSignature: false,
    };
  }

  const byteRange = byteRangeMatch.slice(1, 5).map(Number);

  // the signature bytes live as hex between the two ByteRange gaps
  const contentsStart = byteRange[0] + byteRange[1] + 1;
  const contentsEnd = byteRange[2] - 1;
  const hex = raw.slice(contentsStart, contentsEnd).replace(/0+$/, "");
  const normalizedHex = hex.length % 2 === 0 ? hex : hex.slice(0, -1);

  if (normalizedHex.length === 0) {
    return {
      byteRange,
      certificateCommonNames: [],
      signerCommonName: undefined,
      hasSignature: false,
    };
  }

  const der = forge.util.hexToBytes(normalizedHex);
  const asn1 = forge.asn1.fromDer(der);
  const message = forge.pkcs7.messageFromAsn1(asn1) as forge.pkcs7.PkcsSignedData;

  const certificates = message.certificates ?? [];
  const certificateCommonNames = certificates
    .map(extractCommonName)
    .filter((name): name is string => name !== undefined);

  return {
    byteRange,
    certificateCommonNames,
    signerCommonName: certificateCommonNames[0],
    hasSignature: certificates.length > 0,
  };
};
