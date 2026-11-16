---
"@omnidotdev/signet-api": minor
---

Signing emails now come from the sender by name, replies reach the sender, and the sender can add a note to signers. Reminders are labeled as reminders. Requests expire (120 days by default, adjustable or off), with a last reminder 3 days before and an email to signers and the sender on expiry. A signer removed from a request, or moved to another address, is told their link no longer works. An expired or canceled link now says so up front instead of failing at signing
