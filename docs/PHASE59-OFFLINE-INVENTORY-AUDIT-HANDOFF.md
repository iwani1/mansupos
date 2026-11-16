# Phase 5.9 — Offline Inventory Audit Handoff Manifest (Metadata Only)

**Draft PR #1, unmerged and undeployed.** No Contabo, WooCommerce, Paystack, live POS, checkout, stock import, stock adjustment, cash receipt, automated stock deduction, or payment changes.

## What this build does

An authenticated Owner can download a single **read-only, minimized evidence manifest** that combines Phase 5.7 stock-readiness requirements with Phase 5.8 provisional reconciliation packet status. This is an **export for separately arranged professional review**, not a completed independent audit or an acceptance certificate.

- Owner interface: **Operations → Physical stock counts → Inventory audit handoff — metadata only**.
- GET-only, read-only-live-pilot API: `GET /api/stock-safety/audit-handoff`.
- Optional `expectedRef=<sha256>` rejects changed exports with HTTP 409.
- No POST endpoint. No file upload, external message sending, reviewer invite, digital signature, certificate issuance, inventory approval or live write route.
- The export is generated over the **entire current historical source**, before any filtering or pagination. It fails closed on incomplete source evidence, identity mismatches, duplicate rows, inconsistent Phase 5.7/5.8 revisions, or oversized data (maximum 5,000 rows / 2 MiB of canonical content). It does not silently produce a partial export.
- The source hash, dossier/exception/readiness/packet revision references, per-row SKU and evidence hash, unresolved discrepancy flag, nine proof requirement states, global proof requirements, current provisional packet intent/status and reviewer-account *finding code* are included.

**Not included:** provisional unit counts, private Owner notes, reviewer private issue notes, passwords, tokens, names/addresses/phone numbers of people, customer/order/payment details, original evidence documents, raw physical staff count values, sales data or pricing.

This export contains business SKUs and investigation categories; protect it as confidential business evidence and send it to the intended independent professional only through an Owner-approved channel outside MansuPOS.

## Integrity checksum and independent local comparison

The response shape contains a `content` object and a `sha256` digest. The SHA-256 covers **UTF-8 JSON of only the content object, with object keys recursively sorted and no extra whitespace**. It omits variable timestamps, ensuring identical unchanged source evidence produces identical checksums. The response itself states all stock and payment permissions are disabled.

To detect changes to the exported file, **record the displayed checksum separately in a trusted location before handing over the JSON**. The repo includes a standalone Node.js verifier using built-in libraries only:

```bash
node scripts/verify-inventory-audit-handoff.mjs \
  mansupos-unverified-inventory-audit-<suffix>.json \
  <the-64-character-SHA-256-recorded-separately>
```

The verifier checks file format and non-approval flags, recomputes SHA-256 from the canonical content and compares BOTH the contained checksum and the separately supplied checksum. A missing external checksum, incorrect hash, altered metadata or unsafe stock authorization flag causes failure.

**A matching checksum is not a cryptographic signature.** It cannot prove who created the file, real-world reviewer identity, document originality, staff counts, the presence or quantity of garments, system compromise resistance, or that any third party independently witnessed anything. If the 'separate' checksum was merely copied from an untrusted modified file, the integrity check does not establish authenticity. Independent custody controls, independently verified signers, witnessed current recounts and a separately approved release process remain mandatory.

## Explicit fail-closed limitations

The export, every item and its global requirements remain blocked. In particular:
`auditOnly:true`, `metadataOnly:true`, `releaseReady:false`,
`inventoryAccepted:false`, `independentlyAuthenticatedWitness:false`,
`originalDocumentAuthenticityVerified:false`,
`signedCurrentPhysicalCountVerified:false`, `mappingApproved:false`,
`ownerApproved:false`, `stockImportAuthorized:false`,
`checkoutAuthorized:false`, `paymentsAuthorized:false`.
The accepted-row and approved-for-import counts remain zero.

No import or payment process may treat this evidence as a stock source of truth.

## Verification

- `tests/inventory-audit-handoff.test.js`: deterministic SHA-256 across unchanged evidence, checksum change upon new reviewer finding, no leakage of Owner-proposed quantities or notes, strict Owner role, source identity mismatch, forbidden approval flags, standalone offline verifier with separately recorded hash, tampered manifest rejection.
- `tests/independent-reviewer-access.test.js`: authenticated API, restricted reviewer/staff 403, Owner manifest 200, stale checksum 409, permanently locked stock-import and checkout flags.
- Existing Phase 5.4–5.8 safety tests remain unchanged, except for a corrected Phase 5.8 Owner UI provisional-unit field and an unused-variable lint fix.
- **CI must pass on the exact latest commit**: lint, automated tests, Docker, Windows packaging and browser workflows. Do not infer green from earlier branch commits.

**Do not merge or deploy the PR** or enable Contabo/WooCommerce/Paystack production changes as a result of this evidence export.
