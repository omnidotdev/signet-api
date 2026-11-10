---
"@omnidotdev/signet-api": minor
---

feat: load the signing identity from a mounted PKCS#12 file

`loadServiceSigner` now accepts `SIGNET_SIGNER_P12_FILE` (with
`SIGNET_SIGNER_PASSPHRASE_FILE`) in addition to the base64 env, so a
cert-manager-managed keystore (the Omni-CA-issued signer cert, chain included)
can be mounted and read directly. File takes precedence over base64; base64 and
the ephemeral fallback are unchanged.
