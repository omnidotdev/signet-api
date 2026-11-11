---
"@omnidotdev/signet-api": minor
---

feat(sign): in-app signing for signed-in signers and saved signatures

Adds session-authenticated endpoints so a signed-in user who is also a signer can sign a document in-app without the emailed capability link: `GET/POST /api/documents/:id/sign-as-me` and `.../sign-as-me/decline` resolve the user's signer by email and reuse the existing token-based signing flow (the capability token never leaves the server). Adds a per-user saved signature (`user_signature` table) with `GET/PUT /api/me/signature`, so an adopted signature is reused across a user's documents and devices. The post-sign notification side effects are factored into shared helpers used by both the token and in-app flows.
