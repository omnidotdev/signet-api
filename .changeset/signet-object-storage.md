---
"@omnidotdev/signet-api": minor
---

feat: store PDFs in object storage instead of inline in Postgres

With S3-compatible object storage configured (Fractal object storage / Garage /
MinIO via `S3_BUCKET`/`S3_ENDPOINT`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`),
original and sealed PDFs are stored as objects and only a key is kept on the
document row, keeping large blobs out of the database. With no storage
configured, PDFs stay inline as base64 exactly as before. The switch is
per-write and forward-only: existing inline rows keep working with no migration,
and `/health` reports `objectStorage`.
