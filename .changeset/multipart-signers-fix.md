---
"@omnidotdev/signet-api": patch
---

Fix sending a document with signers from the upload form. The form sends its
signer list as a JSON string, but the server framework JSON-parses multipart
text fields that look like JSON, so the list arrived as an array and the request
was rejected as invalid (422) before anything was created. `/api/documents` and
`/api/drafts` now accept the signer list either way, and ignore malformed
entries instead of failing.
