# Phase 5.1 — Private Physical-Count File Integrity Register

**Status: GitHub DRAFT development, not deployed to Contabo.**
**The server does NOT receive or store file contents. This is not a verified
signature, witnessed count or stock approval.**

## Owner workflow

Under **Operations → Physical stock counts → Count document fingerprints —
not independent verification**, an authenticated Owner may:

1. Open current historical rows with at least two submitted staff count
   claims, including discrepant rows that must remain open.
2. Select an original PDF/PNG/JPEG stored in private custody on the Owner's
   computer (maximum 10 MiB). MansuPOS reads the file **locally in the
   browser**, checks the superficial file header and computes SHA-256 using
   the browser's Web Crypto API. This is not a malware scan or verification
   of the image, PDF contents, signature, author or timestamp.
3. Submit **only** the lowercase 64-hex SHA256, MIME, byte count, document
   category, private document reference code, current physical source
   fingerprint, first/second count claim IDs and request UUID.
   **Filename, original document bytes, faces/photos, names, quantities,
   credentials and customers are never sent by this feature.**
4. At a later date, choose a candidate original file locally and compare
   its SHA-256/MIME/byte length to the saved fingerprint. “BYTES MATCH”
   establishes only byte equality, not genuine signatures or correct stock.
   A different or edited copy reports “BYTES DIFFER.”
5. Investigate any identical fingerprints registered against multiple
   source rows. A single document *can* legitimately cover multiple rows;
   the flag is for investigation only and is not acceptance.
6. Keep actual original documents in a separately access-controlled,
   encrypted and backed-up private repository or physical evidence cabinet.
   No online storage, viewing, or independent signature validation exists.

The owner should use anonymous internal document reference codes (4–48 safe
alphanumeric characters/dashes/underscores). Never put names, personal IDs,
customer details, order details, account credentials or payment references
in the code. Staff cannot view saved SHA-256 or use the owner document
register; employees continue to submit blind first/second count claims.

## API and storage

- `GET /api/stock-safety/count-file-manifests` and
  `POST /api/stock-safety/count-file-manifests`: Owner-only, authenticated,
  bounded and rate-limited; require `POS_MODE=live` and
  `POS_LIVE_READ_ONLY=true`. JSON metadata only; **no multipart upload**.
- GET supports bounded `page`, `pageSize`, `status`, `search` and an
  optional `expectedRef` for stable pagination. Returns
  `Cache-Control: no-store`.
- Each POST validates exact field schema: report row, current register
  fingerprint, exact first/second claim IDs, previous file-manifest ID,
  private code, category `count_sheet` / `witness_statement` /
  `garment_photo`, MIME PDF/PNG/JPEG, file size 8 bytes–10 MiB, SHA-256
  and request UUID. Unknown fields, file contents, file names, approval
  flags and unsupported types are rejected. The server **cannot confirm
  that the browser honestly calculated the supplied hash**.
- Staff count source and Woo product identities must be complete/fresh.
  The server ties metadata to the same signed historical source and the
  current supervisor evidence revision, with distinct first/second audit
  event IDs. SQLite `BEGIN IMMEDIATE` checks current register revision
  and previous manifest ID before appending a new
  `inventory.private_count_file_manifest` audit event in the existing
  POS v9 append-only journal. No new schema.
- Exact same request UUID and payload is idempotently replayed; UUID reused
  with changed content, stale revision, unknown source row or invalid first/
  second count fails closed. The event is not an independent certificate,
  cannot edit/delete earlier audit entries, and lacks tamper-resistant
  off-host notarization. A compromised administrator/DB is outside this
  feature's proof model.
- The revision hash includes source+count supervision and latest document
  event IDs across the entire source. Paginated owner review with an old
  `expectedRef` fails HTTP 409. Woo catalogue refreshes with unchanged
  identity keep the reference stable.
- Hashes recorded against unequal staff declarations NEVER resolve a count
  discrepancy. Historical source/variation identity changes do not silently
  reuse outdated document manifests in the current view.

**The web client computes SHA-256 from the selected original file only
on a secure browser origin. All bytes stay in the browser; the file input
is cleared after hashing.** Original file custody and independent review
are external requirements, not implemented.

## No authorization

All responses include:
`documentContentUploaded:false`,
`independentWitnessVerified:false`,
`ownerApproved:false`,
`stockImportAuthorized:false`,
`checkoutAuthorized:false`.
The owner list also explicitly reports
`fileSignatureVerified:false`,
`mappingApproved:false`,
`sharedStockVerified:false`.

Recording a fingerprint is NOT physical witnessing, proof of a signed
original, stock verification, mapping acceptance or permission for a Woo
import. Installed WooCommerce orders, Paystack callbacks, reservations,
stock owner, live POS sales and checkout remain untouched. Per the Owner's
explicit instruction, **do not deploy this branch on Contabo**, merge PR
#1 or enable any trading write.

## Automated verification

- `tests/private-count-file-manifests.test.js`: browser-compatible local
  SHA-256 and format guard, pure SQLite manifest journal, append-only
  events, mismatched counts, role checks, UUID replay, changed evidence,
  no confidential amounts, source-invalid and paging rejection.
- `tests/physical-count-claims-app.test.js`: isolated application
  authentication, owner-only GET/POST contract, forbidden file bytes and
  approval fields, no Woo payment/order/stock write.
- `tests/browser-live-pilot.mjs`: simulated Owner PDF file selection,
  on-device hash, metadata-only POST and subsequent local byte comparison.

All synthetic tests use fake data and do not examine actual clothes,
documents, Contabo, Woo order balances, customers or real staff identity.
