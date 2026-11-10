---
"@omnidotdev/signet-api": minor
---

feat: RFC 3161 trusted timestamp on sealed documents

When a document is sealed, Signet asks a Time-Stamping Authority (set via
`SIGNET_TSA_URL`) to timestamp the sealed document's hash, proving when it was
signed independent of Signet's clock. The TimeStampToken is recorded in the
provenance ledger and the trusted time is exposed in the document status. Only
the hash is sent to the TSA, and timestamping is best-effort, so a TSA outage
never blocks sealing.
