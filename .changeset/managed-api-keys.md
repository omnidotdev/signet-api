---
"@omnidotdev/signet-api": minor
---

Add managed API keys for programmatic sending. An account issues named keys
(`POST /api/keys`, the `sgk_` secret is returned once and only its SHA-256 hash
is stored), lists them (`GET /api/keys`), and revokes them (`DELETE
/api/keys/:id`). A key sent as `Authorization: Bearer` acts as its owner in the
workspace active when it was issued, on the same routes as the signed-in app. A
presented key never falls back to a browser session, key management refuses
key-authenticated requests, each key is rate limited (120 requests a minute by
default, `429` with `Retry-After`), and an owner may hold up to 25 active keys.
The README now documents API access, templates, and bulk send, and reflects
what the service does today.
