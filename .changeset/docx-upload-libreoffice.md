---
"@omnidotdev/signet-api": minor
---

Install headless LibreOffice (Writer) in the API image so DOCX uploads convert to
PDF with full fidelity. This activates the office converter shipped alongside
image upload: a Word document uploaded to sign or send is now rendered to PDF
server-side instead of being rejected as an unsupported format.
