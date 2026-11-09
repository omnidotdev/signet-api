---
"@omnidotdev/signet-api": minor
---

feat: add persisted send-for-signature with a tamper-evident provenance trail

Documents, signers, and provenance events persist in Postgres. Shareable
capability-token links let a sender request a signature and a signer sign from
a link, with status tracking, signed-PDF download, and void.
