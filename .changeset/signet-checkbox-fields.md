---
"@omnidotdev/signet-api": minor
---

feat(fields): support checkbox fields

A checkbox field now carries the signer's tick state ("true"/"") like a text field, and the signed PDF draws a check mark into any ticked box (an unticked box draws nothing). This lets documents include consent and acknowledgement checkboxes alongside signature, initials, date, and text fields.
