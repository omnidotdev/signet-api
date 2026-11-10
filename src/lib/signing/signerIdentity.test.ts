import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateSelfSignedPkcs12,
  loadServiceSigner,
} from "./signerIdentity.ts";

const SIGNER_VARS = [
  "SIGNET_SIGNER_P12_FILE",
  "SIGNET_SIGNER_P12_BASE64",
  "SIGNET_SIGNER_PASSPHRASE",
  "SIGNET_SIGNER_PASSPHRASE_FILE",
  "SIGNET_SIGNER_NAME",
];

afterEach(() => {
  for (const v of SIGNER_VARS) delete process.env[v];
});

describe("loadServiceSigner", () => {
  test("loads a PKCS#12 from a mounted file with a passphrase file", () => {
    const dir = mkdtempSync(join(tmpdir(), "signet-signer-"));
    const p12 = generateSelfSignedPkcs12({
      commonName: "Signet by Omni",
      passphrase: "s3cret",
    });
    const p12Path = join(dir, "keystore.p12");
    const pwPath = join(dir, "password");
    writeFileSync(p12Path, p12);
    writeFileSync(pwPath, "s3cret\n");

    process.env.SIGNET_SIGNER_P12_FILE = p12Path;
    process.env.SIGNET_SIGNER_PASSPHRASE_FILE = pwPath;
    process.env.SIGNET_SIGNER_NAME = "Signet by Omni";

    const signer = loadServiceSigner();
    expect(signer.ephemeral).toBe(false);
    expect(signer.commonName).toBe("Signet by Omni");
    expect(signer.passphrase).toBe("s3cret");
    expect(Buffer.from(signer.pkcs12)).toEqual(Buffer.from(p12));
  });

  test("the file source takes precedence over the base64 env", () => {
    const dir = mkdtempSync(join(tmpdir(), "signet-signer-"));
    const fileP12 = generateSelfSignedPkcs12({ commonName: "File" });
    const p12Path = join(dir, "keystore.p12");
    writeFileSync(p12Path, fileP12);

    process.env.SIGNET_SIGNER_P12_FILE = p12Path;
    process.env.SIGNET_SIGNER_P12_BASE64 = Buffer.from(
      generateSelfSignedPkcs12({ commonName: "Base64" }),
    ).toString("base64");

    const signer = loadServiceSigner();
    expect(Buffer.from(signer.pkcs12)).toEqual(Buffer.from(fileP12));
  });

  test("falls back to an ephemeral identity when nothing is configured", () => {
    const signer = loadServiceSigner();
    expect(signer.ephemeral).toBe(true);
  });
});
