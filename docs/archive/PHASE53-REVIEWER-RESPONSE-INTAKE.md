# Phase 5.3 — Owner-reported Reviewer Responses and Evidence Discrepancies

**STATUS: DRAFT GitHub-only development. No Contabo deployment, stock
import, external-reviewer account or independent-review certificate.**

## Scope

After Phase 5.2 records a **private custody seal declaration** and the
Owner requests independent examination of a specific original count file,
the Owner can use **Operations → Physical stock counts → Reported reviewer
responses — NOT independently confirmed**.

The Owner may record a reported external response:
- `acknowledgement_reported`: the Owner says an external reply/receipt was
  received. This is **NOT a login-based reviewer acknowledgement** and
  never confirms the reviewer saw or verified the original.
- `discrepancy_reported`: an alleged review discrepancy requiring a specific
  issue code: checksum mismatch, missing signature, disputed count figures,
  style/colour/size variation mismatch, reviewer identity unconfirmed,
  or another unresolved problem.
- `review_unavailable`: requested review was declined/unavailable.
  No document or inventory verification occurred.

Each owner claim includes only an anonymous reviewer reference code,
short one-line note (12–180 chars), exact file SHA-256, document manifest ID,
current custody-review request ID, both count-claim audit IDs,
source snapshot reference and a UUID. Never enter a human name, personal
identifier, customer information, credential, address or payment information.

**Important:** The system currently has only Owner, Manager and Cashier
accounts, with NO independent-reviewer role or external authentication
protocol. Giving an external person an ordinary POS staff login would
also expose unrelated business functions. This phase intentionally does
not provision any reviewer login or suggest that an Owner's report
represents independent confirmation. The anonymous reviewer code must
not equal the Owner's POS account ID or either staff counter's ID; that
is merely a collision check and **does not verify identity or independence**.
An appropriate future design must issue a separately scoped reviewer
capability, verify identity in a controlled channel, and accept an
independent, signed acknowledgement; this phase does none of those things.

## Technical controls

- Owner-only `GET /api/stock-safety/reviewer-responses` with bounded
  page 1–10000, pageSize 1–50, search <=64, explicit status filter and
  snapshot-bound `expectedRef`. Returns `Cache-Control: no-store`.
- Owner-only `POST /api/stock-safety/reviewer-responses`, protected by
  authentication, rate limiting, live READ-ONLY pilot gating, and strict
  Zod parsing. Unknown fields, arbitrary approval actions, fake signatures
  or witness-certification flags are rejected. No file bytes are uploaded
  or delivered.
- A current private file manifest, existing custody seal and the **latest
  custody event being `independent_review_requested`** are mandatory.
  Recheck current signed historical source, Woo published identity
  observation, manifest SHA, count IDs and exact request ID.
- The app reads the account IDs from the original count journal to reject
  a reviewer reference identical to Owner/first/second counter account IDs.
  This prevents a simple reference collision but cannot authenticate a
  person, confirm actual reviewer independence or prove document delivery.
- Under a single SQLite `BEGIN IMMEDIATE`, compare current source-bound
  revision and latest response event; append an
  `inventory.external_reviewer_response_claim` to the EXISTING
  append-only audit journal. UUID replay with exactly the same event
  returns its original ID; modified reuse, old count/source/custody
  versions or a superseded note fail HTTP 409.
- Product/SKU identity changes, newer count declarations, replacement of a
  document fingerprint or a new custody record invalidate old current
  responses; prior events stay preserved in the local audit log.
  Browser pagination with an old source revision fails HTTP 409.
- No new schema, public endpoint, staff-facing response record, Woo order
  or stock write, POS sale, payment, physical count adjustment, certificate,
  file upload, account elevation or checkout code.

The UI deliberately distinguishes **Owner reports acknowledgement
(unverified)** and **Owner reports discrepancy (open)** from real
independent review. A separate `countDiscrepancyOpen` flag remains true
when original staff claims differ, even if the latest owner entry says
an acknowledgement was received. Reported discrepancies are never
silently approved or resolved.

All GET responses retain:
`externalReviewerLoginAvailable:false`,
`reviewerIdentityVerified:false`,
`independentReviewConfirmed:false`,
`documentSignatureVerified:false`,
`independentWitnessVerified:false`,
`ownerApproved:false`,
`mappingApproved:false`,
`sharedStockVerified:false`,
`stockImportAuthorized:false`,
`checkoutAuthorized:false`.

All POST responses retain the relevant non-approval flags. A document hash
checks only the bytes of an Owner-selected file, and an Owner-reported reply
is not an external audit trail.

## Verification

- `tests/reviewer-response-intake.test.js`: complete synthetic
  count → file fingerprint → custody seal → review request → Owner
  discrepancy/receipt reports; identity collision checks, strict validation,
  stale snapshots, journal idempotency and no independent approval.
- `tests/physical-count-claims-app.test.js`: isolated Express Owner,
  Cashier/Manager/public restrictions and all non-approval API fields with
  fake Woo products-only GETs and zero live sale/stock mutation.
- `tests/browser-live-pilot.mjs`: simulated Owner reports a document issue
  and then a later alleged acknowledgement; verifies the original count
  discrepancy remains OPEN and no stock approval is exposed.

All test data are synthetic. No real external reviewer receives files or
access to the POS. For genuine independent-review evidence, require a
separately designed reviewer-only authentication/enrollment and signed
review acknowledgement, offsite journal protection, supervised physical
stock count, verified variation crosswalk, Woo stock-reservation acceptance,
and an explicitly approved trading rollout.

Continue development in draft PR #1, **unmerged and not deployed**.
Existing live Contabo read-only pilot release `8d1117fc` remains untouched.
