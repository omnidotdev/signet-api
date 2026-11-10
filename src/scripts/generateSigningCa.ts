/**
 * Generate the Omni Signing Root CA and a Signet signer certificate chained to
 * it, then assemble a PKCS#12 bundle (leaf key + leaf cert + root cert) for
 * signet-api's SIGNET_SIGNER_P12_BASE64.
 *
 * Unlike the per-pod self-signed fallback, signatures made with this bundle
 * carry the full chain, so any verifier that trusts the published Omni Signing
 * Root CA validates them (fixing the "unknown issuer" state). The provenance
 * ledger and (later) an RFC-3161 timestamp remain the tamper-evidence layer.
 *
 * Usage:
 *   bun run src/scripts/generateSigningCa.ts <out-dir> [--root-key <pem>]
 *
 * Pass --root-key to re-issue the Signet leaf under an EXISTING root (so the
 * published root keeps validating); omit it to mint a fresh root. Outputs, in
 * <out-dir>:
 *   omni-signing-root-ca.pem      (PUBLIC - publish this; verifiers trust it)
 *   omni-signing-root-ca-key.pem  (SECRET - store in Pulumi/Bitwarden to re-issue)
 *   signet-signer.p12             (the leaf bundle)
 *   signet-signer-p12.base64      (-> pulumi config set --secret signet:signer-p12-base64)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import forge from "node-forge";

const ROOT_CN = "Omni Signing Root CA";
const ROOT_O = "Omni";
const LEAF_CN = "Signet by Omni";
const LEAF_O = "Omni";
const ROOT_YEARS = 20;
const LEAF_YEARS = 2;

const serial = (): string =>
  forge.util.bytesToHex(forge.random.getBytesSync(16));

const notAfter = (years: number): Date => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + years);
  return d;
};

const main = () => {
  const [outDir, flag, rootKeyPath] = process.argv.slice(2);
  if (!outDir) {
    console.error("usage: generateSigningCa.ts <out-dir> [--root-key <pem>]");
    process.exit(1);
  }

  // Root CA: reuse an existing key when re-issuing, else mint a fresh one
  let rootPrivateKey: forge.pki.rsa.PrivateKey;
  let rootPublicKey: forge.pki.rsa.PublicKey;
  if (flag === "--root-key" && rootKeyPath) {
    rootPrivateKey = forge.pki.privateKeyFromPem(
      readFileSync(rootKeyPath, "utf8"),
    ) as forge.pki.rsa.PrivateKey;
    rootPublicKey = forge.pki.setRsaPublicKey(
      rootPrivateKey.n,
      rootPrivateKey.e,
    );
  } else {
    const keys = forge.pki.rsa.generateKeyPair(4096);
    rootPrivateKey = keys.privateKey;
    rootPublicKey = keys.publicKey;
  }

  const rootAttrs = [
    { name: "commonName", value: ROOT_CN },
    { name: "organizationName", value: ROOT_O },
  ];
  const rootCert = forge.pki.createCertificate();
  rootCert.publicKey = rootPublicKey;
  rootCert.serialNumber = serial();
  rootCert.validity.notBefore = new Date();
  rootCert.validity.notAfter = notAfter(ROOT_YEARS);
  rootCert.setSubject(rootAttrs);
  rootCert.setIssuer(rootAttrs);
  rootCert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", critical: true, keyCertSign: true, cRLSign: true },
    { name: "subjectKeyIdentifier" },
  ]);
  rootCert.sign(rootPrivateKey, forge.md.sha256.create());

  // Signet leaf: signed by the root, usable only for signing documents
  const leafKeys = forge.pki.rsa.generateKeyPair(2048);
  const leafCert = forge.pki.createCertificate();
  leafCert.publicKey = leafKeys.publicKey;
  leafCert.serialNumber = serial();
  leafCert.validity.notBefore = new Date();
  leafCert.validity.notAfter = notAfter(LEAF_YEARS);
  leafCert.setSubject([
    { name: "commonName", value: LEAF_CN },
    { name: "organizationName", value: LEAF_O },
  ]);
  leafCert.setIssuer(rootAttrs);
  leafCert.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    {
      name: "keyUsage",
      critical: true,
      digitalSignature: true,
      nonRepudiation: true,
    },
    { name: "extKeyUsage", emailProtection: true },
    { name: "authorityKeyIdentifier", keyIdentifier: true },
    { name: "subjectKeyIdentifier" },
  ]);
  leafCert.sign(rootPrivateKey, forge.md.sha256.create());

  // PKCS#12: leaf key + the full chain (leaf, root), empty passphrase to match
  // the existing wiring (SIGNET_SIGNER_PASSPHRASE unset)
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(
    leafKeys.privateKey,
    [leafCert, rootCert],
    "",
    { algorithm: "3des" },
  );
  const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
  const p12Base64 = forge.util.encode64(p12Der);

  writeFileSync(
    join(outDir, "omni-signing-root-ca.pem"),
    forge.pki.certificateToPem(rootCert),
  );
  writeFileSync(
    join(outDir, "omni-signing-root-ca-key.pem"),
    forge.pki.privateKeyToPem(rootPrivateKey),
  );
  writeFileSync(
    join(outDir, "signet-signer.p12"),
    Buffer.from(p12Der, "binary"),
  );
  writeFileSync(join(outDir, "signet-signer-p12.base64"), p12Base64);

  console.log(`Wrote CA + signer bundle to ${outDir}`);
  console.log(`  root CA valid until ${rootCert.validity.notAfter.toISOString()}`);
  console.log(`  signer valid until  ${leafCert.validity.notAfter.toISOString()}`);
};

main();
