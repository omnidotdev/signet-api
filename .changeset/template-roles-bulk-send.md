---
"@omnidotdev/signet-api": minor
---

Templates now carry per-signer roles and the full field setup. Saving a
multi-signer draft as a template records which signer role fills each field
("Signer 1", "Signer 2", ...) along with each field's options, requirement, date
format, and color; starting from the template maps the given signers onto those
roles in order and refuses a start that leaves a role without a signer
(`signers_for_each_role`). Templates saved before roles existed keep working as
single-role templates.

Add bulk send: `POST /api/templates/:id/bulk-send` sends one template to up to
100 recipients in one request. Each row (a signer with an email for every role)
becomes its own sent document and its signers are emailed their links. Every row
is validated before anything is created, so a bad batch never half-sends; a row
that fails afterwards is reported without stopping the rest.
