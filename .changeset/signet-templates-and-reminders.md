---
"@omnidotdev/signet-api": minor
---

feat: reusable templates and automatic signer reminders

Senders can save a document's PDF and field layout as a reusable, account-scoped
template and start new signing requests from it in one step. A background sweep
emails signers who still have a document waiting on them, rate-limited per
signer, respecting sequential signing order, and never after a signer has
signed.
