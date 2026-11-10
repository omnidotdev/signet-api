---
"@omnidotdev/signet-api": minor
---

feat: emit document and signature lifecycle CloudEvents to Vortex

Signet now publishes `signet.document.created`, `signet.document.sent`,
`signet.signature.completed`, `signet.document.completed`, and
`signet.document.voided` events (source `omni.signet`) through the Vortex events
provider, so billing, analytics, and integrations can react to signing activity.
Emission is best-effort and fire-and-forget: a Vortex outage never blocks a
signing operation, and with no Vortex configured the provider is a noop.
