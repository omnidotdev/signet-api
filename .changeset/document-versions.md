---
"@omnidotdev/signet-api": minor
---

Add document versions. `POST /api/documents/:id/revise` takes a new file (PDF,
image, or Word) for a sent, completed, declined, or voided document and creates
the next version as a draft linked to it, with the same signers, order, signing
mode, verification setting, and field layout, ready to review and send. A
document still out for signature is voided first (recorded in its audit trail);
a completed one is never changed, so it remains the record of what was signed.
Fields on pages the new file no longer has are dropped. Document details now
include the version number and links to the previous and next versions.
