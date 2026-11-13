---
"@omnidotdev/signet-api": minor
---

Add signer identity verification by emailed one-time code. When a sender
requires it, a signer must enter a one-time code emailed to them before the
fill page opens, and a signature is refused server-side until they do. The
verification is recorded in the tamper-evident provenance chain and rendered
per signer on the Certificate of Completion. Documents carry a new
`verificationLevel` (`none` or `email_otp`); an authenticated owner signing
their own copy is exempt.
