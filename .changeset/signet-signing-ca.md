---
"@omnidotdev/signet-api": minor
---

feat: Omni Signing Root CA for a trusted signer chain

Add a reproducible generator (`bun signing:ca`) that mints an Omni Signing Root
CA and a Signet signer certificate chained to it, bundled as a PKCS#12 whose
signatures carry the full chain (fixing the self-signed "unknown issuer" state
for verifiers that trust the Omni root). The public root CA is published at
`/omni-signing-root-ca.pem`.
