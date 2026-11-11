---
"@omnidotdev/signet-api": minor
---

feat(fields): enforce required fields at signing

Fields carry a `required` flag (already a column) through the editor and signer-fill data, and `signByToken` now refuses a signature while any required field the signer owns is unfilled (returns `missing_required`). Signature/initials are satisfied by the adopted signature and dates fill themselves.
