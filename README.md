# 🖋 Signet API

Signet is Omni's provenance-first e-signature service: sign documents with a
cryptographically verifiable signature and a tamper-evident provenance trail,
fully self-hostable and freely embeddable across Omni products.

Status: early development. The signing core is implemented and verified; the
service layer (Elysia + Postgraphile + Drizzle), Gatekeeper identity, Arbor
storage, and Vortex events are not built yet.

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

## Try it

```sh
bun install
bun test        # signing + provenance unit tests
bun run demo    # writes a signed PDF to ~/Downloads/signet-demo
```

## Roadmap (see plan)

`~/projects/omni/plans/2026-11-08-signet-esign-and-fabric-substrate-design.md`

- Trusted timestamps (RFC-3161)
- Gatekeeper-issued signer certificates
- Multi-signer flows and an embeddable signing widget
- Elysia + Postgraphile + Drizzle service, Arbor storage, Vortex events

## License

Apache-2.0, &copy; Omni LLC.
