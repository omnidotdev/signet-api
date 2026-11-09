import forge from "node-forge";

export interface SelfSignedOptions {
  commonName?: string;
  organization?: string;
  passphrase?: string;
  validityYears?: number;
}

/**
 * Generate a self-signed PKCS#12 bundle.
 *
 * Used as the development-fallback signing identity and in tests. Production
 * signing identities come from Gatekeeper-issued certificates with a real trust
 * chain, not from this helper
 */
export const generateSelfSignedPkcs12 = (
  options: SelfSignedOptions = {},
): Uint8Array => {
  const commonName = options.commonName ?? "Signet Signer";
  const organization = options.organization ?? "Omni";
  const passphrase = options.passphrase ?? "";
  const validityYears = options.validityYears ?? 1;

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(
    cert.validity.notBefore.getFullYear() + validityYears,
  );

  const attrs = [
    { name: "commonName", value: commonName },
    { name: "organizationName", value: organization },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase, {
    algorithm: "3des",
  });
  const der = forge.asn1.toDer(asn1).getBytes();

  return Uint8Array.from(der, (char) => char.charCodeAt(0));
};

export interface ServiceSigner {
  pkcs12: Uint8Array;
  passphrase: string;
  commonName: string;
  /** Whether this is an ephemeral dev-fallback identity rather than a real one */
  ephemeral: boolean;
}

/**
 * Load the service signing identity from the environment, or generate an
 * ephemeral development identity when none is configured.
 *
 * Set SIGNET_SIGNER_P12_BASE64 (base64-encoded PKCS#12 DER) and optionally
 * SIGNET_SIGNER_PASSPHRASE to provide a real identity. When unset the service
 * still boots with a warning and signs with an ephemeral self-signed identity
 */
export const loadServiceSigner = (): ServiceSigner => {
  const base64 = process.env.SIGNET_SIGNER_P12_BASE64;
  const passphrase = process.env.SIGNET_SIGNER_PASSPHRASE ?? "";
  const commonName = process.env.SIGNET_SIGNER_NAME ?? "Signet Signer";

  if (base64) {
    return {
      pkcs12: Uint8Array.from(Buffer.from(base64, "base64")),
      passphrase,
      commonName,
      ephemeral: false,
    };
  }

  console.warn(
    "SIGNET_SIGNER_P12_BASE64 not set, signing with an ephemeral self-signed identity",
  );
  return {
    pkcs12: generateSelfSignedPkcs12({ commonName, passphrase }),
    passphrase,
    commonName,
    ephemeral: true,
  };
};
