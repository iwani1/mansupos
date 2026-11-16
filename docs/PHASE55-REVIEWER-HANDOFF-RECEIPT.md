# Phase 5.5 — Out-of-Band Reviewer Handoff Challenge and File-Fingerprint Receipt

**Status: draft development only. Not deployed. No document transport, verified real-world identity, independent witness certification, stock approval or live POS checkout.**

## Purpose and evidence boundary

Phase 5.4 introduced restricted reviewer POS accounts and case-specific
metadata access. Phase 5.5 adds a **one-time, short-lived handoff secret**,
Owner-declared identity-check method and reviewer-side receipt evidence to
help correlate an external handoff with the exact assigned count document.

**Do not call this verified identity or a secure document transfer.**
MansuPOS sends **no PDF, PNG, JPEG, signed file, identification document,
email, SMS or physical shipment** to the reviewer. Only a password-protected,
case-scoped reviewer account can confirm possession of an Owner-delivered
secret. That proves **secret possession under an authenticated POS account**,
not receipt of the original paper, a verified human, a qualified independent
witness, count accuracy or document provenance.

The Owner can report an identity-check method, but that is solely
an Owner assertion. No documents or personal identity details are retained
to support verification. Manual controls, identity proofing and independently
safeguarded evidence remain outstanding.

## Owner workflow

1. Under **Operations → Physical stock counts → Independent reviewer access**,
   create and assign an eligible reviewer account as in Phase 5.4.
2. Select which check the Owner reports performing:
   `owner_reports_in_person_check`,
   `owner_reports_known_contact_callback`, or
   `owner_reports_organization_callback`. These are not service-verified.
3. Select a planned **external** channel: in person, a separately secured
   external channel or a sealed paper copy.
4. Issue the one-time handoff challenge for the exact current reviewer
   grant, count claims, file SHA-256, source and custody request.
5. Privately deliver the generated challenge **separately from the original
   document** to the verified intended human. It is returned in the
   response **once only**, expires after 24 hours, and cannot be recovered
   by retrying the same request.
6. Watch the assignment status for `awaiting_challenge`,
   `expired`, `account_receipt_recorded` or
   `inactive_or_stale`. A prior receipt remains in the append-only journal.
   Any discrepancy still requires external investigation.

There is no arbitrary transfer URL, no upload endpoint, no address/phone
field, no free-text government-ID field, and no original-file bytes sent to
the POS server.

## Reviewer workflow

The logged-in reviewer sees only their assigned case metadata and a
**Confirm handoff challenge** action while the challenge is active.

They enter the 64-character Owner-delivered secret, then optionally select
a PDF, JPEG or PNG **locally within their browser** (maximum 10 MiB).
Web Crypto calculates a SHA-256 fingerprint of the local bytes; **file bytes
are never uploaded**. Only the digest is included in the authenticated
receipt. Browser display compares it with the previously stored manifest.

The response includes:
- `file_not_available` — no file selected; observed hash must be null.
- `fingerprint_match_reported` — reporter supplies the matching digest.
- `fingerprint_mismatch_reported` — reporter supplies a different digest.

The server checks that the selected outcome and observed digest are
consistent with the manifest. Because client-side computation can be
fabricated, a matching digest remains **reviewer-reported fingerprint
evidence**, not proof of provenance, signature or physical inspection.

No response resolves an original staff-count discrepancy, authorizes a
mapping or issues an inventory acceptance certificate.

## Security controls

- **Owner-only POST**
  `/api/stock-safety/reviewer-access/handoff`.
- **Reviewer-only POST**
  `/api/reviewer/handoff-receipt`.
- Both require live READ-ONLY pilot mode, an authenticated role and
  existing origin checks and sensitive-action rate limiting.
- Strict Zod schemas with unknown-field rejection, one-use UUID request
  identifiers and exact source/custody/file/claim-bound snapshot checks.
- Cryptographically secure 256-bit random secret; its SHA-256 digest,
  bound to the grant ID and a domain separator, is stored instead of
  the plaintext. A 24-hour expiration is enforced. Compare digests using
  `timingSafeEqual`.
- A single active challenge per grant. An expired challenge can be
  replaced, but not after a receipt has already been recorded for that
  grant. Superseded challenges are rejected. Revocation and stale
  source/custody/file evidence block new receipt submissions.
- Append-only audit events `inventory.reviewer_handoff_issued` and
  `inventory.reviewer_handoff_receipt` under SQLite `BEGIN IMMEDIATE`.
  Exactly repeated submissions are idempotent; UUID reuse with altered
  contents fails. A replay never returns the original plaintext secret.
- No client-provided privileged field can assert approval, human identity
  verification, certificate issuance, payment or stock movement.

The existing audit journal is local and append-only to normal application
calls; this does **not** make it independently tamper-proof. A compromised
Owner or reviewer credential, intercepted out-of-band secret, or collusion
can still produce misleading evidence. A real secure document-delivery
service, externally verified reviewer identity, stronger authentication,
off-site evidence escrow and independent witness controls are future
release requirements.

## Live release blocks

All endpoints in Phase 5.5 and their UI remain on **draft PR #1 only**.
Do not merge, deploy to Contabo, install new WooCommerce plugins, activate
Paystack, perform stock imports, create cash sales or enable checkout.

The API keeps these flags false: `reviewerHumanIdentityVerified`,
`reviewerIndependenceVerified`, `originalFileDeliveredByPOS`,
`originalDocumentVerified`, `signatureVerified`,
`physicalCountVerified`, `independentWitnessVerified`,
`ownerApproved`, `mappingApproved`, `sharedStockVerified`,
`stockImportAuthorized`, `checkoutAuthorized`.

## Verification

The isolated synthetic
`tests/independent-reviewer-access.test.js` extends Phase 5.4 end-to-end
coverage with unauthorized Owner/staff/reviewer routes, strict handoff
fields and snapshot checks, one-time secret issuance, redaction from
GET responses and journal, idempotent replay without secret disclosure,
invalid tokens, inconsistent file hashes, one authenticated receipt,
replay conflicts, no approval, and no Woo write operations.

Run `npm test`, `npm run lint`, Docker, Windows packaging, and browser
workflow checks in CI before considering review. Tests use synthetic data.
