---
"@omnidotdev/signet-api": minor
---

Strengthen the signing audit trail and enforce electronic-records consent. The signed provenance event now records the signer's origin IP address, browser user-agent, and email, and the Certificate of Completion renders the IP and device for each signer. ESIGN / UETA consent is now a hard gate: a signature is refused with `consent_required` unless the signer affirmatively consents, across the signer, sign-as-me, and self-sign paths.
