---
"@omnidotdev/signet-api": patch
---

fix: only auto-detect fields on real fill blanks

Field auto-detection placed a field next to every prose mention of
"sign"/"date"/"initials", producing dozens of false fields on a real document
(43 on a 20-page agreement). It now detects a field only where there is an
actual blank to fill (an underscore line), classifies a long signing line as a
signature rather than the trailing "Date" label, and reads a label to the left
of a separate blank.
