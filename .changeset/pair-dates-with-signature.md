---
"@omnidotdev/signet-api": patch
---

Give each signer the date next to their own signature in side-by-side signature
blocks. When a document is sent without placing fields by hand, dates were paired
to signatures by height alone, so every date on a two-column signing line went
to the first signer and was filled in when they signed, even if the other party
signed days later. Dates now go to the nearest signature by true distance.
