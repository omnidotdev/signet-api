---
"@omnidotdev/signet-api": minor
---

Let signers choose a handwriting style for a typed signature. Besides the classic
oblique style, three bundled handwriting faces (Sacramento, Mr Dafoe, Homemade
Apple, under the SIL Open Font License and Apache 2.0) are available. The chosen
face is embedded, subset to the glyphs of the signer's name, into the sealed PDF
for that signer's signature and initials; a name the face cannot render falls
back to the classic style. The style is stored on the signer and on a user's
saved signature. Unknown style values are stored as the classic default.
