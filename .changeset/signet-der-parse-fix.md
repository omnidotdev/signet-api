---
"@omnidotdev/signet-api": patch
---

fix: parse the signature CMS by its ASN.1 length

`inspectPdfSignature` read the embedded signature by stripping trailing zeros
from the placeholder region, which truncated a CMS whose final DER byte was
legitimately `0x00` and threw "too few bytes to read ASN.1 value"
nondeterministically. It now reads the CMS by its declared ASN.1 length.
