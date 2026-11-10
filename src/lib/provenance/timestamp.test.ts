import { afterEach, describe, expect, test } from "bun:test";
import forge from "node-forge";
import {
  buildTimestampRequest,
  parseTimestampResponse,
  requestTimestamp,
} from "./timestamp.ts";

describe("RFC 3161 timestamping", () => {
  afterEach(() => {
    process.env.SIGNET_TSA_URL = undefined;
  });

  test("builds a TimeStampReq carrying the SHA-256 message imprint", () => {
    const hashHex = "ab".repeat(32); // 32-byte SHA-256
    const der = buildTimestampRequest(hashHex);
    const asn1 = forge.asn1.fromDer(der);
    // TimeStampReq ::= SEQUENCE { version, messageImprint, certReq }
    expect(asn1.type).toBe(forge.asn1.Type.SEQUENCE);
    const value = asn1.value as forge.asn1.Asn1[];
    // version INTEGER = 1
    expect((value[0]?.value as string).charCodeAt(0)).toBe(1);
    // messageImprint ::= SEQUENCE { algId, hashedMessage OCTET STRING }
    const imprint = value[1]?.value as forge.asn1.Asn1[];
    const hashed = imprint[1]?.value as string;
    expect(forge.util.bytesToHex(hashed)).toBe(hashHex);
  });

  test("returns null when no TSA is configured", async () => {
    process.env.SIGNET_TSA_URL = undefined;
    expect(await requestTimestamp(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  test("rejects a non-granted or malformed response", () => {
    expect(parseTimestampResponse("not-der", "http://tsa")).toBeNull();
    // a TimeStampResp whose status is 2 (rejection) yields no token
    const rejected = forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.SEQUENCE,
      true,
      [
        forge.asn1.create(
          forge.asn1.Class.UNIVERSAL,
          forge.asn1.Type.SEQUENCE,
          true,
          [
            forge.asn1.create(
              forge.asn1.Class.UNIVERSAL,
              forge.asn1.Type.INTEGER,
              false,
              String.fromCharCode(2),
            ),
          ],
        ),
      ],
    );
    const der = forge.asn1.toDer(rejected).getBytes();
    expect(parseTimestampResponse(der, "http://tsa")).toBeNull();
  });
});
