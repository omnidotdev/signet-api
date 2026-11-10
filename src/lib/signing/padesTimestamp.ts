/**
 * PAdES-T: embed an RFC 3161 signature timestamp inside a PDF signature's CMS.
 *
 * After the detached PKCS#7 (CMS) signature is applied, this asks the TSA to
 * timestamp the signer's signature value and adds the returned TimeStampToken
 * to the SignerInfo as an unsigned attribute (id-aa-timeStampToken). An unsigned
 * attribute is not covered by the signature's message digest, and the PDF
 * /Contents region is excluded from the ByteRange, so adding it leaves both the
 * ByteRange digest and the signature itself valid. Standards-compliant readers
 * then show a trusted signing time embedded in the document (not only in
 * Signet's provenance ledger).
 *
 * Best-effort: any failure (no TSA, parse error, placeholder too small) returns
 * the input unchanged, so sealing never breaks.
 */

import forge from "node-forge";

import { requestTimestampTokenDer } from "../provenance/timestamp.ts";

// id-aa-timeStampToken (RFC 3161)
const TIMESTAMP_TOKEN_OID = "1.2.840.113549.1.9.16.2.14";

const BYTE_RANGE_PATTERN =
  /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/;

/** Length of the DER object starting at the front of a forge byte-string */
const derObjectLength = (bytes: string): number | null => {
  if (bytes.length < 2 || bytes.charCodeAt(0) === 0) return null;
  const lengthByte = bytes.charCodeAt(1);
  if (lengthByte < 0x80) return 2 + lengthByte;
  const count = lengthByte & 0x7f;
  if (count === 0 || bytes.length < 2 + count) return null;
  let length = 0;
  for (let i = 0; i < count; i++)
    length = length * 256 + bytes.charCodeAt(2 + i);
  const total = 2 + count + length;
  return bytes.length >= total ? total : null;
};

const { asn1 } = forge;
const isOctetString = (node: forge.asn1.Asn1) =>
  node.tagClass === asn1.Class.UNIVERSAL && node.type === asn1.Type.OCTETSTRING;
const isSet = (node: forge.asn1.Asn1) =>
  node.tagClass === asn1.Class.UNIVERSAL && node.type === asn1.Type.SET;

/**
 * Add a signature timestamp to a signed PDF. Returns the input unchanged on any
 * failure, so callers can always use the result.
 */
export const embedSignatureTimestamp = async (
  pdf: Uint8Array,
): Promise<Uint8Array> => {
  if (!process.env.SIGNET_TSA_URL) return pdf;
  try {
    const raw = Buffer.from(pdf).toString("latin1");
    const m = raw.match(BYTE_RANGE_PATTERN);
    if (!m) return pdf;
    const [rangeStart, sigStart, sigEnd] = m.slice(1, 4).map(Number) as [
      number,
      number,
      number,
    ];
    // the CMS hex sits between the ByteRange gaps, inside < >
    const contentsStart = rangeStart + sigStart + 1;
    const contentsEnd = sigEnd - 1;
    let regionHex = raw.slice(contentsStart, contentsEnd);
    if (regionHex.length % 2 === 1) regionHex = regionHex.slice(0, -1);
    const regionBytes = forge.util.hexToBytes(regionHex);
    const derLength = derObjectLength(regionBytes);
    if (derLength === null) return pdf;

    const cmsDer = regionBytes.slice(0, derLength);
    const cms = asn1.fromDer(cmsDer);

    // ContentInfo -> [0] EXPLICIT -> SignedData
    const signedData = (cms.value as forge.asn1.Asn1[])[1]?.value as
      | forge.asn1.Asn1[]
      | undefined;
    const signedDataSeq = signedData?.[0];
    if (!signedDataSeq || !Array.isArray(signedDataSeq.value)) return pdf;

    // signerInfos is the trailing SET; take the first SignerInfo
    const members = signedDataSeq.value as forge.asn1.Asn1[];
    const signerInfos = [...members].reverse().find(isSet);
    const signerInfo = signerInfos?.value?.[0] as forge.asn1.Asn1 | undefined;
    if (!signerInfo || !Array.isArray(signerInfo.value)) return pdf;

    // the signature value is the lone top-level OCTET STRING in the SignerInfo
    const signatureNode = (signerInfo.value as forge.asn1.Asn1[]).find(
      isOctetString,
    );
    const signatureStr =
      signatureNode && typeof signatureNode.value === "string"
        ? signatureNode.value
        : null;
    if (!signatureStr) return pdf;

    const tokenDer = await requestTimestampTokenDer(
      Uint8Array.from(signatureStr, (c) => c.charCodeAt(0)),
    );
    if (!tokenDer) return pdf;
    const tokenAsn1 = asn1.fromDer(tokenDer);

    // Attribute ::= SEQUENCE { type OID, values SET OF AttributeValue }
    const attribute = asn1.create(
      asn1.Class.UNIVERSAL,
      asn1.Type.SEQUENCE,
      true,
      [
        asn1.create(
          asn1.Class.UNIVERSAL,
          asn1.Type.OID,
          false,
          asn1.oidToDer(TIMESTAMP_TOKEN_OID).getBytes(),
        ),
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, [tokenAsn1]),
      ],
    );
    // unsignedAttrs [1] IMPLICIT SET OF Attribute (@signpdf adds none, so create)
    const unsignedAttrs = asn1.create(asn1.Class.CONTEXT_SPECIFIC, 1, true, [
      attribute,
    ]);
    (signerInfo.value as forge.asn1.Asn1[]).push(unsignedAttrs);

    const newDer = asn1.toDer(cms).getBytes();
    const regionLen = contentsEnd - contentsStart;
    const newHex = forge.util.bytesToHex(newDer);
    if (newHex.length > regionLen) return pdf; // placeholder too small, keep as-is
    const padded = newHex + "0".repeat(regionLen - newHex.length);

    const out = raw.slice(0, contentsStart) + padded + raw.slice(contentsEnd);
    return Uint8Array.from(Buffer.from(out, "latin1"));
  } catch (err) {
    console.warn("[signet] PAdES-T timestamp embed failed", err);
    return pdf;
  }
};
