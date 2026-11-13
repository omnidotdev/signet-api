# @omnidotdev/signet-api

## 0.3.0

### Minor Changes

- [#71](https://github.com/omnidotdev/signet-api/pull/71) [`5060413`](https://github.com/omnidotdev/signet-api/commit/5060413d9c69d34bf3392fa2b1b6dada1b2b2c2b) Thanks [@coopbri](https://github.com/coopbri)! - Add signer identity verification by emailed one-time code. When a sender
  requires it, a signer must enter a one-time code emailed to them before the
  fill page opens, and a signature is refused server-side until they do. The
  verification is recorded in the tamper-evident provenance chain and rendered
  per signer on the Certificate of Completion. Documents carry a new
  `verificationLevel` (`none` or `email_otp`); an authenticated owner signing
  their own copy is exempt.

## 0.2.0

### Minor Changes

- [#61](https://github.com/omnidotdev/signet-api/pull/61) [`d9e18df`](https://github.com/omnidotdev/signet-api/commit/d9e18dfa38f0b02012b179b2a61cdd113fbe709e) Thanks [@coopbri](https://github.com/coopbri)! - Strengthen the signing audit trail and enforce electronic-records consent. The signed provenance event now records the signer's origin IP address, browser user-agent, and email, and the Certificate of Completion renders the IP and device for each signer. ESIGN / UETA consent is now a hard gate: a signature is refused with `consent_required` unless the signer affirmatively consents, across the signer, sign-as-me, and self-sign paths.

## 0.1.0

### Minor Changes

- [#39](https://github.com/omnidotdev/signet-api/pull/39) [`b6192de`](https://github.com/omnidotdev/signet-api/commit/b6192debd7f2910ca03f3e3a5e4f45e56fe58f02) Thanks [@coopbri](https://github.com/coopbri)! - feat(fields): support checkbox fields

  A checkbox field now carries the signer's tick state ("true"/"") like a text field, and the signed PDF draws a check mark into any ticked box (an unticked box draws nothing). This lets documents include consent and acknowledgement checkboxes alongside signature, initials, date, and text fields.

- [#38](https://github.com/omnidotdev/signet-api/pull/38) [`39f7323`](https://github.com/omnidotdev/signet-api/commit/39f7323d8f27cd96003e5940b85668da5c7bc32d) Thanks [@coopbri](https://github.com/coopbri)! - feat(documents): correct a pending signer on a sent document

  Owners can now fix a typo in the name or reassign the email of a signer who has not yet signed or declined on a sent document. Changing the email rotates that signer's sign token (invalidating the old link) and re-sends the signing email; a signer who has already signed or declined is immutable, preserving the integrity of a captured signature. Exposed as `POST /api/documents/:id/signers/:signerId` (owner-scoped).

- [#41](https://github.com/omnidotdev/signet-api/pull/41) [`dc02ede`](https://github.com/omnidotdev/signet-api/commit/dc02edeedcec35e38a6d7aee80944f175519d452) Thanks [@coopbri](https://github.com/coopbri)! - feat(fields): support dropdown and radio fields

  A dropdown or radio field stores its choices (a new `options` column) and the signer's chosen option (like a text value), which is drawn into the signed PDF. Additive migration only.

- [`679c353`](https://github.com/omnidotdev/signet-api/commit/679c3533f2e25204a61dd20be511dc7596a68791) - feat: email signing links to signers via Herald

  When a signer email is provided, the signing link is emailed through the Herald
  notification provider. Degrades gracefully to a stdout noop when Herald is not
  configured, so send-for-signature still returns the link either way.

- [#12](https://github.com/omnidotdev/signet-api/pull/12) [`3066ae8`](https://github.com/omnidotdev/signet-api/commit/3066ae8556a9250d2fdbd8180b44618b49edee09) Thanks [@coopbri](https://github.com/coopbri)! - feat: load the signing identity from a mounted PKCS#12 file

  `loadServiceSigner` now accepts `SIGNET_SIGNER_P12_FILE` (with
  `SIGNET_SIGNER_PASSPHRASE_FILE`) in addition to the base64 env, so a
  cert-manager-managed keystore (the Omni-CA-issued signer cert, chain included)
  can be mounted and read directly. File takes precedence over base64; base64 and
  the ephemeral fallback are unchanged.

- [#35](https://github.com/omnidotdev/signet-api/pull/35) [`0fc072e`](https://github.com/omnidotdev/signet-api/commit/0fc072edefc6f557bb5c90096063e5ed903c6b7a) Thanks [@coopbri](https://github.com/coopbri)! - feat(sign): in-app signing for signed-in signers and saved signatures

  Adds session-authenticated endpoints so a signed-in user who is also a signer can sign a document in-app without the emailed capability link: `GET/POST /api/documents/:id/sign-as-me` and `.../sign-as-me/decline` resolve the user's signer by email and reuse the existing token-based signing flow (the capability token never leaves the server). Adds a per-user saved signature (`user_signature` table) with `GET/PUT /api/me/signature`, so an adopted signature is reused across a user's documents and devices. The post-sign notification side effects are factored into shared helpers used by both the token and in-app flows.

- [#10](https://github.com/omnidotdev/signet-api/pull/10) [`a9dca6e`](https://github.com/omnidotdev/signet-api/commit/a9dca6e90c7d4b1a7a52f3b47148152e5c92d81b) Thanks [@coopbri](https://github.com/coopbri)! - feat: store PDFs in object storage instead of inline in Postgres

  With S3-compatible object storage configured (Fractal object storage / Garage /
  MinIO via `S3_BUCKET`/`S3_ENDPOINT`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`),
  original and sealed PDFs are stored as objects and only a key is kept on the
  document row, keeping large blobs out of the database. With no storage
  configured, PDFs stay inline as base64 exactly as before. The switch is
  per-write and forward-only: existing inline rows keep working with no migration,
  and `/health` reports `objectStorage`.

- [#11](https://github.com/omnidotdev/signet-api/pull/11) [`660864e`](https://github.com/omnidotdev/signet-api/commit/660864e0eae3a349836bf8ff7a027f400cf74f91) Thanks [@coopbri](https://github.com/coopbri)! - feat: scope documents to the sender's workspace

  A signed-in sender's active workspace (Gatekeeper organization) is now read from
  userinfo via the `organization` OIDC scope and stamped on documents they create
  (`document.organization_id`). This is the service/data foundation for
  workspace-scoped visibility; anonymous sends and existing documents are
  unaffected.

- [#40](https://github.com/omnidotdev/signet-api/pull/40) [`b126606`](https://github.com/omnidotdev/signet-api/commit/b12660615b6f370c2ebd3016cfc9583361736f9f) Thanks [@coopbri](https://github.com/coopbri)! - feat(documents): owner-scoped add, edit, and remove signers on a draft

  Owner-session endpoints to manage a draft's signer roster, so the signed-in owner can add a signer, edit a signer's name/email, or remove a signer (never the last one) from the editor without a manage link: `POST`, `PATCH`, and `DELETE` on `/api/documents/:id/signers[/:signerId]`. The draft mutation logic is shared with the existing manage-token endpoints.

- [#45](https://github.com/omnidotdev/signet-api/pull/45) [`abe5ff6`](https://github.com/omnidotdev/signet-api/commit/abe5ff6de9761302ec2e42a24a54dd79b96f0e6a) Thanks [@coopbri](https://github.com/coopbri)! - feat(fields): scattered radio-button groups

  Radio fields can be placed as individual buttons linked by a `group_id` (new column), so one choice can be selected across buttons scattered on the page (DocuSign-style). Each radio button carries its label in `options[0]`; the signed PDF draws an outlined circle, filled for the chosen option, with the label beside it. Additive migration only.

- [#44](https://github.com/omnidotdev/signet-api/pull/44) [`fb514c2`](https://github.com/omnidotdev/signet-api/commit/fb514c2bf9b53d6c36786032a388f2589182c928) Thanks [@coopbri](https://github.com/coopbri)! - feat(fields): enforce required fields at signing

  Fields carry a `required` flag (already a column) through the editor and signer-fill data, and `signByToken` now refuses a signature while any required field the signer owns is unfilled (returns `missing_required`). Signature/initials are satisfied by the adopted signature and dates fill themselves.

- [`1814426`](https://github.com/omnidotdev/signet-api/commit/1814426e1c719cef0b63e5f59038dc26559ede96) - feat: add persisted send-for-signature with a tamper-evident provenance trail

  Documents, signers, and provenance events persist in Postgres. Shareable
  capability-token links let a sender request a signature and a signer sign from
  a link, with status tracking, signed-PDF download, and void.

- [#42](https://github.com/omnidotdev/signet-api/pull/42) [`52c5f46`](https://github.com/omnidotdev/signet-api/commit/52c5f468d6c1625128d6ebf1d1ce727a30c137a9) Thanks [@coopbri](https://github.com/coopbri)! - feat(documents): add and remove signers on a sent document

  Owners can now add a late approver to a sent document (appended, emailed their link) and remove a still-pending signer added in error. Signed or declined signers stay immutable, the last signer cannot be removed, and a removal that would strand the document (leaving only signed signers) is refused. The existing `POST`/`DELETE` signer endpoints now dispatch to the draft or sent path automatically.

- [#14](https://github.com/omnidotdev/signet-api/pull/14) [`8245e98`](https://github.com/omnidotdev/signet-api/commit/8245e984344353620b43e00b40748bd2e7eb4be5) Thanks [@coopbri](https://github.com/coopbri)! - feat: add, remove, and edit signers on a draft

  Senders can change who signs a document while it is still a draft: add a signer,
  remove one (their fields go with them, and order is renumbered), or edit a
  signer's name/email, from the editor or the API. The roster is locked once the
  document is sent, so a signature in progress can never be invalidated, and a
  document can never be left with zero signers. Each change is recorded in the
  provenance trail. The send email now uses the real document name.

- [#13](https://github.com/omnidotdev/signet-api/pull/13) [`bcb3623`](https://github.com/omnidotdev/signet-api/commit/bcb3623149ab70c299f4c0bb92d3b85929fe9eda) Thanks [@coopbri](https://github.com/coopbri)! - feat: Omni Signing Root CA for a trusted signer chain

  Add a reproducible generator (`bun signing:ca`) that mints an Omni Signing Root
  CA and a Signet signer certificate chained to it, bundled as a PKCS#12 whose
  signatures carry the full chain (fixing the self-signed "unknown issuer" state
  for verifiers that trust the Omni root). The public root CA is published at
  `/omni-signing-root-ca.pem`.

- [#8](https://github.com/omnidotdev/signet-api/pull/8) [`3a387ff`](https://github.com/omnidotdev/signet-api/commit/3a387ff36b98b1942cddd28ec4f0ce71a11daeda) Thanks [@coopbri](https://github.com/coopbri)! - feat: reusable templates and automatic signer reminders

  Senders can save a document's PDF and field layout as a reusable, account-scoped
  template and start new signing requests from it in one step. A background sweep
  emails signers who still have a document waiting on them, rate-limited per
  signer, respecting sequential signing order, and never after a signer has
  signed.

- [#17](https://github.com/omnidotdev/signet-api/pull/17) [`3762f4b`](https://github.com/omnidotdev/signet-api/commit/3762f4b557217c87972ec0386fdc8da283fb16b0) Thanks [@coopbri](https://github.com/coopbri)! - feat: RFC 3161 trusted timestamp on sealed documents

  When a document is sealed, Signet asks a Time-Stamping Authority (set via
  `SIGNET_TSA_URL`) to timestamp the sealed document's hash, proving when it was
  signed independent of Signet's clock. The TimeStampToken is recorded in the
  provenance ledger and the trusted time is exposed in the document status. Only
  the hash is sent to the TSA, and timestamping is best-effort, so a TSA outage
  never blocks sealing.

- [#9](https://github.com/omnidotdev/signet-api/pull/9) [`bc69625`](https://github.com/omnidotdev/signet-api/commit/bc69625a1f237396324a89b0a2c9e044f68b586e) Thanks [@coopbri](https://github.com/coopbri)! - feat: emit document and signature lifecycle CloudEvents to Vortex

  Signet now publishes `signet.document.created`, `signet.document.sent`,
  `signet.signature.completed`, `signet.document.completed`, and
  `signet.document.voided` events (source `omni.signet`) through the Vortex events
  provider, so billing, analytics, and integrations can react to signing activity.
  Emission is best-effort and fire-and-forget: a Vortex outage never blocks a
  signing operation, and with no Vortex configured the provider is a noop.

- [#16](https://github.com/omnidotdev/signet-api/pull/16) [`c946dfa`](https://github.com/omnidotdev/signet-api/commit/c946dfafd18ff2e79b8d4c20827d65e11918f815) Thanks [@coopbri](https://github.com/coopbri)! - feat: scope documents to workspaces with member access

  Documents are now workspace resources: the dashboard shows the active
  workspace's documents (visible to every member of that workspace) plus the
  sender's own, a lightweight workspace switcher lets a sender change the active
  workspace among the ones they belong to, and signed-document download is
  authorized by ownership or workspace membership. Workspace memberships come from
  the verified Gatekeeper userinfo on the session.

### Patch Changes

- [#15](https://github.com/omnidotdev/signet-api/pull/15) [`f5e47fd`](https://github.com/omnidotdev/signet-api/commit/f5e47fda217069de9809429aff1767cc6be584a6) Thanks [@coopbri](https://github.com/coopbri)! - fix: parse the signature CMS by its ASN.1 length

  `inspectPdfSignature` read the embedded signature by stripping trailing zeros
  from the placeholder region, which truncated a CMS whose final DER byte was
  legitimately `0x00` and threw "too few bytes to read ASN.1 value"
  nondeterministically. It now reads the CMS by its declared ASN.1 length.

- [#18](https://github.com/omnidotdev/signet-api/pull/18) [`32d242c`](https://github.com/omnidotdev/signet-api/commit/32d242c69e21fc85eec8289ce5dcbe0efdb97dad) Thanks [@coopbri](https://github.com/coopbri)! - fix: only auto-detect fields on real fill blanks

  Field auto-detection placed a field next to every prose mention of
  "sign"/"date"/"initials", producing dozens of false fields on a real document
  (43 on a 20-page agreement). It now detects a field only where there is an
  actual blank to fill (an underscore line), classifies a long signing line as a
  signature rather than the trailing "Date" label, and reads a label to the left
  of a separate blank.

- [#37](https://github.com/omnidotdev/signet-api/pull/37) [`6067e45`](https://github.com/omnidotdev/signet-api/commit/6067e45f4c7773f768abf5662b6a99de17e6ffef) Thanks [@coopbri](https://github.com/coopbri)! - feat(email): show the Signet logo and refine the decline callout

  The notification emails now lead with the Signet mark beside the wordmark (a hosted PNG, since email clients cannot render inline SVG). The decline-reason callout drops its accent left edge for a cleaner, plainer block.

- [#36](https://github.com/omnidotdev/signet-api/pull/36) [`4f21636`](https://github.com/omnidotdev/signet-api/commit/4f2163659e9cb33dfbbba188a3e23bff378ffc7b) Thanks [@coopbri](https://github.com/coopbri)! - feat(email): redesign the notification emails with a branded shell

  Signature-request, completion, and decline emails now share one warm, branded layout (`emailShell`): the Signet wordmark, a soft card on a citrine-tinted ground, a pill call-to-action, a plain-text link fallback, and a trust note, so they read as one product. User-supplied values (document name, signer name, decline reason) are HTML-escaped before interpolation.

- [#46](https://github.com/omnidotdev/signet-api/pull/46) [`6e43810`](https://github.com/omnidotdev/signet-api/commit/6e438102143b3e04436faec9f25d523fa53cfaa4) Thanks [@coopbri](https://github.com/coopbri)! - feat(signing): dates are fillable, defaulting to today

  A date field now carries the signer's own value (defaulting to today's date) instead of always stamping today, so a signer can enter an effective date or leave the default.

- [#43](https://github.com/omnidotdev/signet-api/pull/43) [`1821524`](https://github.com/omnidotdev/signet-api/commit/18215248ca3214168fafb97de0905d05eba1a7b6) Thanks [@coopbri](https://github.com/coopbri)! - feat(signing): expose the signer's color in the fill data

  The signer-fill payload now includes the signer's assigned color so the signing view can tint their fields in that color (per-signer coloring, like the field editor).
