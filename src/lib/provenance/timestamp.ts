/**
 * RFC 3161 trusted timestamping.
 *
 * When a document is sealed, Signet asks a Time-Stamping Authority (TSA) to
 * timestamp the sealed document's hash. The returned TimeStampToken proves the
 * document existed at a trusted time, independent of Signet's own clock, which
 * is what gives a signed agreement long-term, legally meaningful signing time.
 *
 * Only the SHA-256 hash is sent to the TSA, never the document, so timestamping
 * leaks nothing about the content. It is best-effort: a TSA outage or missing
 * configuration never blocks sealing (the provenance chain still records the
 * seal, just without a trusted timestamp).
 */

import { createHash } from "node:crypto";
import forge from "node-forge";

const SHA256_OID = "2.16.840.1.101.3.4.2.1";

/** A trusted timestamp over a hash */
export interface TrustedTimestamp {
  /** base64 DER of the RFC 3161 TimeStampToken (a CMS SignedData) */
  token: string;
  /** the TSA's asserted time (ISO 8601), parsed from the token, if readable */
  genTime: string | null;
  /** the TSA endpoint that issued it */
  tsa: string;
}

/** Build the DER of an RFC 3161 TimeStampReq over a SHA-256 hash (hex) */
export const buildTimestampRequest = (hashHex: string): string => {
  const { asn1 } = forge;
  const algorithmIdentifier = asn1.create(
    asn1.Class.UNIVERSAL,
    asn1.Type.SEQUENCE,
    true,
    [
      asn1.create(
        asn1.Class.UNIVERSAL,
        asn1.Type.OID,
        false,
        asn1.oidToDer(SHA256_OID).getBytes(),
      ),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, ""),
    ],
  );
  const messageImprint = asn1.create(
    asn1.Class.UNIVERSAL,
    asn1.Type.SEQUENCE,
    true,
    [
      algorithmIdentifier,
      asn1.create(
        asn1.Class.UNIVERSAL,
        asn1.Type.OCTETSTRING,
        false,
        forge.util.hexToBytes(hashHex),
      ),
    ],
  );
  const request = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    // version INTEGER { v1(1) }
    asn1.create(
      asn1.Class.UNIVERSAL,
      asn1.Type.INTEGER,
      false,
      asn1.integerToDer(1).getBytes(),
    ),
    messageImprint,
    // certReq BOOLEAN TRUE: ask the TSA to include its certificate in the token
    asn1.create(
      asn1.Class.UNIVERSAL,
      asn1.Type.BOOLEAN,
      false,
      String.fromCharCode(0xff),
    ),
  ]);
  return asn1.toDer(request).getBytes();
};

const ASN1_GENERALIZED_TIME = 24; // forge.asn1.Type.GENERALIZEDTIME
const ASN1_SEQUENCE_TAG = 0x30;

/**
 * Recursively find the first GeneralizedTime in an ASN.1 tree. The TSTInfo
 * (which carries the TSA's genTime) is wrapped in an OCTET STRING of raw DER
 * inside the CMS, so descend into any byte-string value that itself begins a
 * DER SEQUENCE.
 */
const findGenTime = (obj: forge.asn1.Asn1): string | null => {
  if (obj.type === ASN1_GENERALIZED_TIME && typeof obj.value === "string") {
    return obj.value;
  }
  if (Array.isArray(obj.value)) {
    for (const child of obj.value) {
      const found = findGenTime(child as forge.asn1.Asn1);
      if (found) return found;
    }
    return null;
  }
  if (
    typeof obj.value === "string" &&
    obj.value.charCodeAt(0) === ASN1_SEQUENCE_TAG
  ) {
    try {
      return findGenTime(forge.asn1.fromDer(obj.value));
    } catch {
      return null;
    }
  }
  return null;
};

/** ASN.1 GeneralizedTime (YYYYMMDDHHMMSS[.fff]Z) to ISO 8601, best-effort */
const genTimeToIso = (value: string): string | null => {
  const m = value.match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?Z?$/,
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac] = m;
  const ms = frac ? `.${frac.slice(0, 3)}` : "";
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${ms}Z`;
};

/** Parse a TimeStampResp DER: returns the token (base64) and genTime, or null */
export const parseTimestampResponse = (
  der: string,
  tsa: string,
): (Omit<TrustedTimestamp, "genTime"> & { genTime: string | null }) | null => {
  try {
    const resp = forge.asn1.fromDer(der);
    if (!Array.isArray(resp.value) || resp.value.length < 1) return null;
    // TimeStampResp ::= SEQUENCE { status PKIStatusInfo, timeStampToken OPTIONAL }
    const statusInfo = resp.value[0] as forge.asn1.Asn1;
    const statusInt =
      Array.isArray(statusInfo.value) && statusInfo.value[0]
        ? (statusInfo.value[0] as forge.asn1.Asn1)
        : null;
    const status =
      statusInt && typeof statusInt.value === "string"
        ? statusInt.value.charCodeAt(0)
        : -1;
    // 0 = granted, 1 = grantedWithMods
    if (status !== 0 && status !== 1) return null;
    const token = resp.value[1] as forge.asn1.Asn1 | undefined;
    if (!token) return null;
    const tokenDer = forge.asn1.toDer(token).getBytes();
    const rawGenTime = findGenTime(token);
    return {
      token: forge.util.encode64(tokenDer),
      genTime: rawGenTime ? genTimeToIso(rawGenTime) : null,
      tsa,
    };
  } catch {
    return null;
  }
};

/**
 * Request a trusted timestamp over the given bytes from the configured TSA.
 * Returns null when no TSA is configured or the request fails (best-effort).
 */
export const requestTimestamp = async (
  bytes: Uint8Array,
): Promise<TrustedTimestamp | null> => {
  const tsa = process.env.SIGNET_TSA_URL;
  if (!tsa) return null;
  const hashHex = createHash("sha256").update(bytes).digest("hex");
  try {
    const reqDer = buildTimestampRequest(hashHex);
    const res = await fetch(tsa, {
      method: "POST",
      headers: { "content-type": "application/timestamp-query" },
      body: Uint8Array.from(reqDer, (c) => c.charCodeAt(0)),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const respDer = Buffer.from(await res.arrayBuffer()).toString("latin1");
    return parseTimestampResponse(respDer, tsa);
  } catch (err) {
    console.warn("[signet] timestamp request failed", err);
    return null;
  }
};
