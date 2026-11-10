---
"@omnidotdev/signet-api": minor
---

feat: scope documents to workspaces with member access

Documents are now workspace resources: the dashboard shows the active
workspace's documents (visible to every member of that workspace) plus the
sender's own, a lightweight workspace switcher lets a sender change the active
workspace among the ones they belong to, and signed-document download is
authorized by ownership or workspace membership. Workspace memberships come from
the verified Gatekeeper userinfo on the session.
