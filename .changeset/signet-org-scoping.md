---
"@omnidotdev/signet-api": minor
---

feat: scope documents to the sender's workspace

A signed-in sender's active workspace (Gatekeeper organization) is now read from
userinfo via the `organization` OIDC scope and stamped on documents they create
(`document.organization_id`). This is the service/data foundation for
workspace-scoped visibility; anonymous sends and existing documents are
unaffected.
