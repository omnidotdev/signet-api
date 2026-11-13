---
"@omnidotdev/signet-api": minor
---

Add sender-configurable field styling. A date field now carries a date format
(ISO, US, EU, or a long "Month D, YYYY" style) that is applied when the signer
signs, so the signed PDF renders the date in the sender's chosen style. Any field
can carry an ink color (as `#rrggbb`) for its stamped mark, falling back to the
default signing ink when unset. Both attributes round-trip through the field
editor and the signer fill data.
