---
"@omnidotdev/signet-api": minor
---

Accept image uploads (PNG, JPEG) when signing or sending a document, converting
each to a single PDF page server-side so the rest of the signing pipeline is
unchanged. Uploads are now recognized by their content (magic bytes), not only
the browser-supplied MIME type. A headless office converter for DOCX is wired in
but stays inactive until the converter binary is present in the runtime image, so
a DOCX upload is rejected with a clean `unsupported_format` until then.
