# Phase 5.4 — Dedicated Independent Reviewer Account and Case-Scoped Acknowledgement

**DRAFT, NOT DEPLOYED.** Implementation is on the existing Phase 2 development
pull request. The live Contabo read-only pilot has **not** been changed. No
checkout, payment, WooCommerce stock import, physical inventory adjustment,
or POS sales write is authorized.

## What this phase actually verifies

A separate `reviewer` account can authenticate with a long one-time
password, rotate it on first login, and use only a case-scoped **metadata**
review page. A later response is attributable to that POS account. This
does **not** establish the account holder's real-world identity,
employment independence, qualified-witness status, physical access to the
document, the truth of their assertions, or originality of signatures.
A case remains review-only even after an account response.

The previous Phase 5.3 Owner-reported reviewer response register is still
Owner assertions. Its unverified response statuses are not changed,
converted, or approved by this new account protocol.

## Owner workflow

From **Operations → Physical stock counts → Independent reviewer access**:

1. Create a username starting `review.`. The server creates a separate
   `reviewer`-role user with a high-entropy password returned **once**
   to the Owner. Only its salted scrypt hash is stored in the POS users
   table; the raw password is not appended to the audit log.
2. Verify the intended human's identity and independence separately.
   Deliver the one-time password via a **private trusted channel**.
   Never broadcast it, place it in shared group chat, or put a credential
   in the GitHub repository.
3. Grant the reviewer one CURRENT custody request. The exact source
   hash, custody version, manifest SHA-256, first/second declaration
   audit IDs, reviewer account ID and UUID are bound into an
   append-only local `inventory.reviewer_access_granted` audit entry.
4. View responses from authenticated accounts separately from Owner
   messages; revoke a grant with an append-only
   `inventory.reviewer_access_revoked` event. Revoked assignments
   can no longer submit new responses. The Owner may also deactivate
   the account using existing Owner account-management controls.

Cases require two distinct recorded staff count declarations, a
current private document fingerprint, a custody seal declaration and
the latest action being `independent_review_requested`.
Source or document replacement invalidates old grants. No original
document bytes are stored or sent by this feature.

## Reviewer workflow and permissions

The reviewer uses the ordinary named-account sign-in solely for
authentication, then sees a separate **Independent reviewer workspace**.
A first-time password change is mandatory before case access.
The reviewer can view only individually granted metadata:

- Source row and SKU while current, custody request audit ID, document
  manifest ID and SHA-256, first/second count declaration audit IDs,
  pending status and whether staff counts disagree.
- Their own prior account-authenticated response (category, note and
  timestamp).

They cannot see count quantities, other historical source entries,
other reviewers' cases, sales, customer records, wholesale pricing,
payments, WooCommerce tokens, POS stock counts or adjustments, or
staff-management functions. Server-side authentication denies **every
ordinary POS API** to a reviewer session, even ordinary endpoints that
were historically not protected by a staff-role check. Only sign-out,
password rotation, assigned-case GET and acknowledgement POST are
allowed through this role's authenticated route gate. The public
`/api/session` still provides basic authenticated session/configuration
metadata as it does for other roles.

Reviewer responses include:

- `review_request_seen`: the signed-in account has seen the assignment
  metadata (NOT the private original document).
- `evidence_issue_reported`: the account has reported a specified issue;
  the issue is NOT independently resolved or verified by this report.
- `unable_to_review`: the account cannot review this evidence.

Each `POST /api/reviewer/acknowledgements` requires a current
case-specific grant, exact snapshot reference, strict category/issue
validation, short note and UUID. It writes an append-only local
`inventory.reviewer_account_acknowledgement` under an SQLite
`BEGIN IMMEDIATE` transaction. Exact replay is idempotent; changed
UUID contents and stale evidence fail closed. The login authenticates
only a POS *account*, not a human identity.

## Routes

All case routes require `POS_MODE=live`,
`POS_LIVE_READ_ONLY=true` and the existing login/session, origin checks,
rate limits and pilot safety interlock.

| Method | Route | Caller |
|---|---|---|
| GET | `/api/stock-safety/reviewer-access` | Owner |
| POST | `/api/stock-safety/reviewer-access/accounts` | Owner |
| POST | `/api/stock-safety/reviewer-access/grants` | Owner |
| POST | `/api/stock-safety/reviewer-access/revoke` | Owner |
| GET | `/api/reviewer/cases` | Dedicated reviewer |
| POST | `/api/reviewer/acknowledgements` | Dedicated reviewer |

No schema migration is required. All account data uses the current
POS users/sessions tables. Evidence events use the existing
append-only POS audit table.

## Safety limits and remaining acceptance work

- **Always false:** human reviewer identity verified, independent
  witness verified, original document delivered by POS, original
  document verified, counts verified, mapping approved, Owner approved,
  stock import authorized and checkout authorized.
- The local audit ledger is *append-only to the application*, **not**
  a tamper-proof external witness or legally verified signature.
- No enrollment identity proofing, MFA, document transport or receipt
  signature, geographic/device trust, independent accountant
  certification or regulator-approved e-signature is provided.
- Reviewer statements cannot resolve discrepancies or release trading.
- Before real human use, conduct supervised account onboarding and
  authorized document delivery; add separate proof of receipt/identity,
  enhanced authentication, cross-device/browser QA, and independent
  penetration/role audit.
- Contabo service, live POS releases, WooCommerce and Paystack are
  not changed.

## QA

`tests/independent-reviewer-access.test.js` covers synthetic staff
counts, private manifest, custody seal, review request, reviewer account
creation, mandatory password rotation, server-side isolation from
unrelated POS APIs, strict grants, stale inputs, append-only authenticated
response, revocation, open count discrepancies, and no Woo writes.
Also run the existing Phase 5.3 tests, linter, Docker build,
browser checks and Windows packaging CI. No real store data is used.

**Do not merge or deploy this feature as proof of inventory readiness.**
