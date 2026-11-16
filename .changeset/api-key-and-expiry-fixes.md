---
"@omnidotdev/signet-api": patch
---

A request with an unknown or revoked API key is now refused with `401 invalid_api_key` instead of being handled as an anonymous send. An `expiresInDays` over 365 is capped at 365 instead of falling back to the default, and the decline email links straight to the document
