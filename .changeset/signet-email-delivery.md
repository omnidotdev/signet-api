---
"@omnidotdev/signet-api": minor
---

feat: email signing links to signers via Herald

When a signer email is provided, the signing link is emailed through the Herald
notification provider. Degrades gracefully to a stdout noop when Herald is not
configured, so send-for-signature still returns the link either way.
