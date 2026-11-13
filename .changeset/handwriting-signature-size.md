---
"@omnidotdev/signet-api": patch
---

Size handwriting signatures to match the classic style. Script faces have very
different letter proportions (the flowing face's lowercase is about half the
height of the handwritten face's at the same point size), and a typed
signature in a handwriting style was stamped smaller than the classic one, in
places smaller than the date beside it. Each face is now sized from its own
x-height so its lowercase stands as tall as the classic signature's, still
shrinking to fit the field's width.
