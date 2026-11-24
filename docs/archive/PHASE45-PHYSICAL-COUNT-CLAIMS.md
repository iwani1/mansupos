# Phase 4.5 — Physical Count Claims Journal (DEVELOPMENT ONLY)

**Status:** Draft code, not deployed to Contabo and not merged. The existing
read-only POS release remains untouched. This development build adds a strictly
**local, append-only claim journal** for physical stock counting, NOT a verified
inventory ledger or WooCommerce stock synchronization.

## Purpose

- Staff sign in to their own POS accounts (Manager or Cashier) and record a
  **first physical count claim** for a historical source row.
- A **different authenticated account** must record a blind second count claim.
  No staff API provides the first count value or first counter's identity.
- Owner-only view shows differences and agreement between the two declarations.
  Even matching numbers are labelled `matching_claims_unverified`, not
  physically witnessed or stock-ready.
- Employee claims cannot approve an import, assign a WooCommerce stock owner,
  clear the source quarantine, edit a product or affect sales.
- Held/quarantined, missing-SKU, duplicate-identity, ambiguous-Woo, and
  parent-only identity rows reject submissions. Only provisional unique-SKU
  links or separately identified physical SKUs missing from published Woo
  can receive count claims (both still require Owner mapping decisions).
- There is **no approval endpoint or owner signoff**.

## Data boundary and authentication

The existing v9 POS SQLite `audit` journal is append-only through triggers.
`inventory.count_claim` events record: snapshot/source SHA256, physical
report row, number of units declared, first/second stage, session-derived actor
ID, server timestamp, client request UUID, and a declaration UUID. The event
does not assert that the actor actually performed a witnessed count.

The server validates count quantities as integers 0–1,000,000, rejects
unexpected fields, enforces authenticated staff role, checks the full
source-bound recount snapshot checksum and current Woo product GET freshness,
and binds every count to a SHA256 of the physical-source fingerprint and
the complete source-row-to-Woo product/variation identity assessment. A routine
Woo refresh with identical identities preserves the count reference; an
actual mapping/source change invalidates previous current-snapshot claims.
Catalogue freshness and signed-source validity are separately checked before
each count submission. The server uses one `BEGIN IMMEDIATE` local transaction
around stage/idempotency
validation plus audit insertion. A replay of the same request key/payload
returns the original claim ID; reuse with another payload or actor returns
HTTP 409. A second count by the first actor returns HTTP 403. A further claim
for an already completed stage returns HTTP 409. There is no edit/delete
route and the existing audit triggers prohibit ordinary updates/deletes.

The count API has three endpoints on **live read-only mode only**:
- `GET /api/stock-safety/count-worklist`: Owner, Manager, Cashier; shows
  only row identities and whether **this staff member** can record a count;
  no first/second quantities or counter names.
- `POST /api/stock-safety/count-claim`: Manager and Cashier; creates a local
  unverified staff declaration after all checks. The Owner cannot be both an
  independent counter and the reviewer in this workflow.
- `GET /api/stock-safety/count-claims-review`: **Owner only**; shows
  first/second quantities, recorded account identifiers, discrepancy/held
  status and a warning for count claims bound to an older snapshot.

All GET list routes are limited to 25 rows by default (at most 50), with
strict search, page bounds and a snapshot consistency token. Server responses
set `Cache-Control: no-store`. No customer information, names, costs or
private Woo order records are returned; the Owner review necessarily
displays sensitive physical quantities and should not be publicly shared.

## What this does NOT verify

- Signing into two staff accounts does **not** verify two different people
  physically handled the same garments. Shared passwords or collusion
  defeat the independence claim. Use named accounts, unique passwords and
  an independently supervised procedure.
- The audit journal remains **local**; append-only database triggers are
  not cryptographic remote evidence or protection from administrator control.
  Preserve encrypted off-VPS backups and independently reviewed restore tests
  before considering deployment.
- A Woo product GET does **not** observe website pending orders, returns or
  available-for-sale quantities. It cannot verify parent-managed stock
  ownership or stop Paystack/website last-unit races.
- A change to the source hash/Woo SKU mapping makes old count claims
  `staleClaimEvents`; historical journal entries are preserved but **not
  silently reused** as current stock.
- No Woo API POST/PUT/DELETE calls, POS sales, payments, stock imports, file
  uploads, receipt printing or owner-approved stock releases exist here.

## Review workflow

1. Owner identifies eligible source rows and checks source/website snapshot.
2. First counter signs into their own account, physically counts a product,
   and submits its **unverified first claim** once.
3. A different counter independently checks the physical product without
   seeing the first quantity, then submits the second claim.
4. Owner reviews mismatches. Matching quantities remain unverified until
   physical witnessing, signed private evidence, actual SKU/variation
   crosswalk and installed Woo stock-owner verification are independently
   completed.
5. The later stock import needs a **different separately approved** process,
   and live checkout needs documented Woo/Paystack/concurrency acceptance.
   This feature cannot authorize either.

## Tests and deployment boundary

`tests/physical-count-claims.test.js` verifies the local engine,
`tests/physical-count-claims-app.test.js` verifies the full live-read-only
auth/API contract using synthetic Woo GETs and an isolated temporary
database. The production-browser fixture covers Owner read-only review.
Testing does **not** connect to the real website, its Woo credentials, real
inventory, employee devices or Contabo.

PR #1 stays **DRAFT**, and the owner has requested that code development
continue in GitHub before any Contabo installation. No deployment
instructions, POS service changes, production schema migrations or live
checkout approval should be issued for this phase.
