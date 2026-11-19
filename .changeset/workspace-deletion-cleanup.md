---
"@omnidotdev/signet-api": minor
---

Deleting a workspace now deletes its Signet documents, with their signers, fields, audit trails, and stored PDFs, and the API keys scoped to it. Signers still holding a live link are told the request was canceled. Templates and saved signatures belong to a person's account and stay
