# 🖋 Signet API

Signet is Omni's provenance-first e-signature service: sign documents with a
cryptographically verifiable signature and a tamper-evident provenance trail,
fully self-hostable and freely embeddable across Omni products.

Status: in production at signet.omni.dev. The service (Elysia + Drizzle on
Postgres) runs send-for-signature end to end: multi-signer and sequential
flows, field placement, templates, email delivery, identity verification by
emailed one-time code, a tamper-evident provenance ledger, RFC 3161
timestamps, and a Certificate of Completion. Identity is Gatekeeper (OIDC),
PDFs can live in S3-compatible storage, and lifecycle events go to Vortex.

## What works today

- **PDF signing** (`src/lib/signing/pdfSigner.ts`): applies a detached PKCS#7
  (PAdES-style) signature over the full document ByteRange using a PKCS#12
  bundle. Built on `pdf-lib` and `@signpdf` (permissive MIT licensing, no
  copyleft in the critical path).
- **Signature inspection** (`inspectPdfSignature`): parses a signed PDF and
  reports the ByteRange and signer identity.
- **Provenance ledger** (`src/lib/provenance/ledger.ts`): an append-only,
  hash-chained event log that makes any tampering with signing history
  detectable. This is the Signet differentiator over commodity e-sign.

Signatures are independently verifiable with standard tooling, for example
poppler's `pdfsig`.

## API access

Send documents from your own systems with a managed API key. Create one on the
Profile page in Signet; the secret is shown once. Send it as a bearer token.
This creates a document from a PDF (or PNG, JPEG, or DOCX) and emails each
signer their link:

```sh
curl https://api.signet.omni.dev/api/documents \
  -H "Authorization: Bearer sgk_..." \
  -F file=@contract.pdf \
  -F 'signers=[{"name":"Ada Lovelace","email":"ada@example.com"}]'
```

A key acts as the account that created it, in the workspace that was active
then, and works on the same routes as the signed-in app (create and send
documents, templates, status, downloads). Each key is limited to 120 requests a
minute (`429` with `Retry-After` beyond that). Keys are managed only from a
signed-in session, never with a key, and can be revoked at any time; a revoked
key stops working immediately. Only a hash of each key is stored.

### Templates and bulk send

A template remembers its signer roles ("Signer 1", "Signer 2", ...) and every
field's role, options, and styling. Send one template to many recipients with
`POST /api/templates/:id/bulk-send`, up to 100 documents per request:

```json
{
  "rows": [
    [
      { "name": "Ada", "email": "ada@example.com" },
      { "name": "HR", "email": "hr@example.com" }
    ],
    [
      { "name": "Grace", "email": "grace@example.com" },
      { "name": "HR", "email": "hr@example.com" }
    ]
  ]
}
```

Each row gives a signer with an email for every role, in role order, and
becomes its own sent document. All rows are validated before anything is
created; a batch with an invalid row is rejected whole (`invalid_rows`, with
the row indexes).

## Try it

```sh
bun install
bun test        # signing + provenance unit tests
bun run demo    # writes a signed PDF to ~/Downloads/signet-demo
```

## Roadmap (see plan)

`~/projects/omni/plans/2026-11-12-signet-gtm-parity-audit.md`

- SMS one-time codes and stronger identity verification tiers
- An embeddable signing widget

## License

Apache-2.0, &copy; Omni LLC.
