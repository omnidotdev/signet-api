---
"@omnidotdev/signet-api": minor
---

feat(fields): scattered radio-button groups

Radio fields can be placed as individual buttons linked by a `group_id` (new column), so one choice can be selected across buttons scattered on the page (DocuSign-style). Each radio button carries its label in `options[0]`; the signed PDF draws an outlined circle, filled for the chosen option, with the label beside it. Additive migration only.
