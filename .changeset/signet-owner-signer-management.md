---
"@omnidotdev/signet-api": minor
---

feat(documents): owner-scoped add, edit, and remove signers on a draft

Owner-session endpoints to manage a draft's signer roster, so the signed-in owner can add a signer, edit a signer's name/email, or remove a signer (never the last one) from the editor without a manage link: `POST`, `PATCH`, and `DELETE` on `/api/documents/:id/signers[/:signerId]`. The draft mutation logic is shared with the existing manage-token endpoints.
