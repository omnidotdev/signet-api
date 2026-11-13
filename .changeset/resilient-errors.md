---
"@omnidotdev/signet-api": patch
---

Harden error handling. The API no longer crashes when its database restarts or
fails over: a dropped idle connection is logged and the pool reconnects, where
previously the unhandled connection error took the whole process down. An
unexpected failure now answers with a generic `internal_error` (details are
logged server-side) instead of returning the raw exception message, a corrupt
or unreadable image or Word upload is rejected as `unsupported_format` (415)
rather than a 500, and a malformed template id returns not-found.
