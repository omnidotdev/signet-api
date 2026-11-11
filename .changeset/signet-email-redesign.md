---
"@omnidotdev/signet-api": patch
---

feat(email): redesign the notification emails with a branded shell

Signature-request, completion, and decline emails now share one warm, branded layout (`emailShell`): the Signet wordmark, a soft card on a citrine-tinted ground, a pill call-to-action, a plain-text link fallback, and a trust note, so they read as one product. User-supplied values (document name, signer name, decline reason) are HTML-escaped before interpolation.
