---
"@omnidotdev/signet-api": minor
---

feat(documents): add and remove signers on a sent document

Owners can now add a late approver to a sent document (appended, emailed their link) and remove a still-pending signer added in error. Signed or declined signers stay immutable, the last signer cannot be removed, and a removal that would strand the document (leaving only signed signers) is refused. The existing `POST`/`DELETE` signer endpoints now dispatch to the draft or sent path automatically.
