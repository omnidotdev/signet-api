---
"@omnidotdev/signet-api": minor
---

feat: add, remove, and edit signers on a draft

Senders can change who signs a document while it is still a draft: add a signer,
remove one (their fields go with them, and order is renumbered), or edit a
signer's name/email, from the editor or the API. The roster is locked once the
document is sent, so a signature in progress can never be invalidated, and a
document can never be left with zero signers. Each change is recorded in the
provenance trail. The send email now uses the real document name.
