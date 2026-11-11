---
"@omnidotdev/signet-api": minor
---

feat(documents): correct a pending signer on a sent document

Owners can now fix a typo in the name or reassign the email of a signer who has not yet signed or declined on a sent document. Changing the email rotates that signer's sign token (invalidating the old link) and re-sends the signing email; a signer who has already signed or declined is immutable, preserving the integrity of a captured signature. Exposed as `POST /api/documents/:id/signers/:signerId` (owner-scoped).
