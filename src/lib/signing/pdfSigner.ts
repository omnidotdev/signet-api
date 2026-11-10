import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { P12Signer } from "@signpdf/signer-p12";
import { SignPdf } from "@signpdf/signpdf";
import forge from "node-forge";
import { PDFDocument } from "pdf-lib";

import { embedSignatureTimestamp } from "./padesTimestamp.ts";

// Reserve enough signature space for the CMS plus an embedded RFC 3161
// timestamp token (PAdES-T), which the signing step adds afterwards
const SIGNATURE_LENGTH = 16384;

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
    signatureLength: SIGNATURE_LENGTH,
  });

  // object streams must stay disabled so the ByteRange stays contiguous and the
  // placeholder survives serialization
  const withPlaceholder = await pdfDoc.save({ useObjectStreams: false });

  const signer = new P12Signer(Buffer.from(pkcs12), {
    passphrase: opts.passphrase,
  });

  const signed = await new SignPdf().sign(Buffer.from(withPlaceholder), signer);

  // add a signature timestamp (PAdES-T) inside the CMS; best-effort, so an
  // unavailable TSA returns the signed PDF unchanged
  return embedSignatureTimestamp(new Uint8Array(signed));
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

const BYTE_RANGE_PATTERN =
  /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/;

const extractCommonName = (cert: forge.pki.Certificate): string | undefined => {
  const field = cert.subject.getField("CN");
  return field?.value as string | undefined;
};

/**
 * Total byte length of the DER object at the start of a binary string (forge's
 * byte-string form): tag + length octets + content. Returns null when the bytes
 * do not begin a DER object (e.g. all padding) or the header is truncated.
 */
const derObjectLength = (bytes: string): number | null => {
  if (bytes.length < 2) return null;
  // a leading zero byte means padding, not an ASN.1 tag
  if (bytes.charCodeAt(0) === 0) return null;
  const lengthByte = bytes.charCodeAt(1);
  if (lengthByte < 0x80) return 2 + lengthByte; // short form
  const count = lengthByte & 0x7f; // long form: number of length octets
  if (count === 0 || bytes.length < 2 + count) return null;
  let length = 0;
  for (let i = 0; i < count; i++)
    length = length * 256 + bytes.charCodeAt(2 + i);
  const total = 2 + count + length;
  return bytes.length >= total ? total : null;
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

  const [rangeStart, sigStart, sigEnd, rangeEnd] = byteRangeMatch
    .slice(1, 5)
    .map(Number);
  if (
    rangeStart === undefined ||
    sigStart === undefined ||
    sigEnd === undefined ||
    rangeEnd === undefined
  ) {
    return {
      byteRange: [],
      certificateCommonNames: [],
      signerCommonName: undefined,
      hasSignature: false,
    };
  }
  const byteRange = [rangeStart, sigStart, sigEnd, rangeEnd];

  // the signature bytes live as hex between the two ByteRange gaps
  const contentsStart = rangeStart + sigStart + 1;
  const contentsEnd = sigEnd - 1;
  // The Contents region is a fixed-size placeholder: the DER-encoded CMS sits at
  // the start and the rest is zero padding. Read the CMS by its own declared
  // ASN.1 length rather than stripping trailing zeros, which would truncate a
  // signature whose final DER bytes are legitimately 0x00 (a nondeterministic
  // "too few bytes to read ASN.1 value" failure)
  let regionHex = raw.slice(contentsStart, contentsEnd);
  if (regionHex.length % 2 === 1) regionHex = regionHex.slice(0, -1);
  const regionBytes = forge.util.hexToBytes(regionHex);
  const derLength = derObjectLength(regionBytes);

  if (derLength === null) {
    return {
      byteRange,
      certificateCommonNames: [],
      signerCommonName: undefined,
      hasSignature: false,
    };
  }

  const der = regionBytes.slice(0, derLength);
  const asn1 = forge.asn1.fromDer(der);
  const message = forge.pkcs7.messageFromAsn1(
    asn1,
  ) as forge.pkcs7.PkcsSignedData;

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
