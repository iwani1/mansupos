---
name: MansutRENDZGH Retail Studio
description: Compact fashion-tech selling and operations workspace with truthful data scope and locked trading gates.
colors:
  surface: "#FFFFFF"
  paper: "#F9F5F7"
  paper-deep: "#F3ECF0"
  ink: "#242124"
  brand: "#DC147E"
  brand-ink: "#B31365"
  support: "#858085"
  line: "#EDE5EA"
  line-dark: "#D9CFD6"
  success: "#2C604A"
  warning: "#765019"
  danger: "#A22F3D"
typography:
  family: "Manrope, system sans-serif"
  body: "14px / 1.5"
  page: "23–28px, weight 800"
  section: "15–18px, weight 700"
  numerals: "tabular for amounts and stock"
rounded:
  control: "4px"
  surface: "5px"
  dialog: "5px"
spacing:
  compact: "8px"
  standard: "12–18px"
  page: "20–27px"
components:
  primary-action: "pink #DC147E on white, plain rectangular control"
  secondary-action: "white with a one-pixel divider"
  surface: "white with a one-pixel border; no default drop shadow"
  status: "text + icon/dot; never color alone"
---

## Identity and implementation

The existing React/Vite POS is the product. Its presentation is a **restrained white, charcoal and pink fashion-tech workroom**, not a generic card dashboard. Manrope is self-hosted through Fontsource; avoid decorative serif display faces, gradients, glass effects, ornate illustrations, gratuitous motion and stacked shadows. Use `src/styles.css` for tokens and the essential application/print layout, then `src/studio.css` for app-wide presentation overrides. Existing `src/instore.css` still contains the locked historical In-store collection layout. The earlier ivory/brass design audit is retained in `docs/UI-DESIGN.md` as history, not the current palette.

Use `#DC147E` for primary actions, selected navigation and larger accents on white; use darker `#B31365` for small pink text on white or `#F9F5F7`. Reserve green, amber and red for named operational states. Keep real photographs only where the connected Woo catalogue provides them; isolated demo illustrations are clearly labelled. No decorative product imagery is added to admin pages. Prices are GHS, displayed in GH₵ with tabular numerals. Long names, SKUs and translations must wrap rather than forcing page-level horizontal overflow.

## Shell and navigation

- A 236px white directory groups **Workspace, Catalogue, Operations and Administration**. Each group can collapse independently. The entire rail can collapse to labelled-tooltip icons; the setting persists on the device. On short desktop heights, the group list scrolls independently while profile/help remain reachable. This is intentional; don't hide a destination to make every item fit a fixed viewport.
- At widths up to 1080px, use a focus-contained drawer. Escape and the scrim close it; navigation returns focus to the new page and the drawer cannot trap focus after resizing to desktop. Mobile shows the Mansu wordmark, search, status, alerts and account when space allows; the page heading supplies context below.
- Header search opens and focuses the real Register search. Alerts come from **loaded** interrupted POS sales and the current catalogue state, not a fabricated notification stream. Demo/read-only/locked/synced states always use words. Profile offers actual workspace/help/logout actions; this shell does not create customer accounts or Woo admin functions.
- New page bodies: `src/Overview.jsx`, `src/Catalogue.jsx`, `src/Customers.jsx` and the existing task pages in `src/Pages.jsx`. Shared heading, buttons, notices, modal, table region and selling-mode switch live in `src/components.jsx`.

## Counter and operational surfaces

- **Retail POS:** search/scan, categories, stock filter, product options and cart stay one fast touchscreen flow. Keep the sale total and **Prepare order** in view at common desktop/tablet counter heights; at 820px and below the full-height cart opens from a fixed sale bar. Retail prices come from Woo/the isolated demo, not from private Wholesale defaults. Preserve cart idempotency, shared-parent stock limits, unknown stock handling, held carts and session recovery.
- **Wholesale:** only owner/manager; start with goods, enter final **all-in** negotiated prices (including any applicable tax), review and approve, then record full payment. Buyer name is optional. Quotes and receipts show an actual tax line only when WooCommerce returned a positive tax amount. Private per-option price defaults are not public retail prices; they require the existing identity/revision safeguards and separate trading permission. The selling-mode switch navigates to this real workflow; it is not an unguarded discount toggle.
- **Overview:** `GET /api/reports?days=1` and `?days=7` drive the actual POS totals, channel mix, daily chart and top goods; `/api/sales` supplies **loaded** unsettled and recent records. `src/catalog-insights.js` counts each known parent-managed stock pool only once. No website sale, historical POS-only In-store receipt or general customer profile is inferred. An incomplete/stale Woo catalogue is labelled and cannot produce an authoritative stock total. Demo values are clearly practice data.
- **Products/Categories/Inventory:** use the loaded Woo catalogue. Products are searchable and inspectable but not editable here; categories filter the real directory. Stock/option source and counts are legible. On tablets, the dense inventory table scrolls sideways with a hint; on phones semantic tables become labelled records. An incomplete/stale catalogue leaves stock units blank in exports; demo CSVs explicitly identify practice data.
- **Sales/Orders:** two contexts for the same **POS-only** ledger, with channel/status/search, detail, receipt, optional quote, payment, cancellation and reconciliation actions still connected to their guarded APIs. Counts of pending orders refer to loaded pages; website orders remain excluded. Customers shows only the existing owner/manager named Wholesale buyers, not invented phone/address/purchase profiles. There is no supplier API; do not ship a fake supplier directory.
- **Reports/Shifts/Staff/Audit/Settings/In-store:** preserve their actual APIs, signed refund charts, cash counts, role limits, audit trails, refresh and diagnostic actions. A synced catalogue never implies that live checkout is approved. Printed receipt dimensions and the offline safety notice remain functional, not decorative.

## States, accessibility and safety

Use native labelled controls, visible keyboard focus, semantic table headers, text status, proper `aria-pressed` for modes and view switches, alert semantics for errors, and focus-managed dialogs. Do not put navigation or account labels behind visible initials. Fields and key touch actions remain reachable at 320px; reduced-motion disables transitions. Device/browser status is not a stock guarantee. The service worker caches only the **public no-sales offline notice**; it never caches authenticated screens, orders or stock.

**The Contabo pilot remains read-only.** This design change neither enables trading nor changes Woo taxes, stock, REST order logic, POS write gates or payment permissions. There has been no supervised genuine Woo sale, Woo pending/paid side-effect acceptance, approved last-unit concurrency control, separate trading ledger backup or production approval. See `docs/LIVE-READONLY-REVIEW.md`, `docs/SHARED-WOO-STOCK.md` and `docs/LIVE-CASH-ROLLOUT.md` before any trading deployment. Do not test design by placing a live dummy order or toggling the retired POS-only stock route.

## Verification

Use an **isolated** `POS_MODE=demo` data directory. `npm test` covers API/gate and catalogue insight cases; `npm run lint`, `npm run build` and `npm run build:live` check source and demo-free live assets. `npm run test:browser` exercises the isolated production-built demo workflows, a read-only pilot fixture, responsive pages, the PWA notice and data-sourced workspace. `npm run test:a11y` checks desktop/phone pages and dialogs with axe. Test 1280×800, 768px tablet, 375px and 320px phones, grouped navigation, search/scan, named ledger records, stock ownership, report scope and checkout locks. These checks are **not** live Woo or hardware acceptance.
