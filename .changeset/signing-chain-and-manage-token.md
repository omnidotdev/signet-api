---
"@omnidotdev/signet-api": patch
---

Signatures now chain to the published Omni Signing Root CA, so a verifier that trusts the root reports the certificate as trusted (the signer certificate named the wrong issuer key). The manage token of an anonymous send is no longer put in URLs: it is returned as `manageToken` and sent in the `x-signet-manage-token` header, and the draft editor opens by submitting it in the request body
