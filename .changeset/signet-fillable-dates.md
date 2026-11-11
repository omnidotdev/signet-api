---
"@omnidotdev/signet-api": patch
---

feat(signing): dates are fillable, defaulting to today

A date field now carries the signer's own value (defaulting to today's date) instead of always stamping today, so a signer can enter an effective date or leave the default.
