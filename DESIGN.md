---
name: MansutRENDZGH Retail Studio
description: A calm, product-led boutique counter with unambiguous operational states.
colors:
  paper: "#f3efe8"
  paper-deep: "#e9e2d7"
  surface: "#fffdf9"
  ink: "#2b2028"
  ink-soft: "#4a3d45"
  ink-hover: "#40303a"
  ink-disabled: "#766d72"
  muted: "#5c5056"
  line: "#ded5ca"
  line-dark: "#c9bcaf"
  brass: "#7a5a2e"
  brass-light: "#e8dccb"
  brass-bright: "#c9a46c"
  wine: "#6e3040"
  sage: "#405843"
  sage-light: "#e7ede6"
  amber: "#7a561f"
  amber-light: "#f4ead6"
  danger: "#8f3d36"
  danger-light: "#f6e7e3"
typography:
  display:
    fontFamily: "'Bodoni Moda', Georgia, serif"
    fontSize: "38px"
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: "-0.8px"
  section:
    fontFamily: "'Bodoni Moda', Georgia, serif"
    fontSize: "23px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.5px"
  body:
    fontFamily: "'DM Sans', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
rounded:
  control: "4px"
  surface: "6px"
  dialog: "8px"
  pill: "999px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    height: "44px"
    padding: "10px 16px"
  button-primary-hover:
    backgroundColor: "{colors.ink-hover}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.control}"
    height: "44px"
    padding: "10px 16px"
  surface:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.surface}"
  badge-warning:
    backgroundColor: "{colors.amber-light}"
    textColor: "{colors.amber}"
    rounded: "{rounded.pill}"
---

## Overview

**Retail studio, not a generic dashboard.** This is a fashion-boutique selling workspace. The garment and the current sale lead; records and configuration are quieter, task-first companions. Keep the incumbent ivory, aubergine-black and restrained brass identity. CSS custom properties in `src/styles.css` are the implementation source of truth; `src/studio.css` composes the current whole-workspace layout on top of those tokens and the existing In-store styles. The frontmatter above captures their portable core. `docs/UI-DESIGN.md` records earlier design decisions and audit history.

The [awesome-design-md collection](https://github.com/voltagent/awesome-design-md) informed the token/component/responsive documentation pattern (Oura, Notion, Nike and Shopify analyses are *different brands*, not themes to borrow). [Impeccable](https://github.com/pbakaus/impeccable) informed the task-first inspection of hierarchy, states, accessibility and responsive behavior. Neither supplied assets, installed skills nor an approval-bypassing workflow to this app.

## Colors

| Use | CSS tokens | Rule |
| --- | --- | --- |
| Canvas and raised content | `--paper`, `--paper-deep`, `--surface`, `--line`, `--line-dark` | Paper holds the workspace; near-white holds data and forms. Dividers, not shadow stacks, separate most information. |
| Primary reading and actions | `--ink`, `--ink-soft`, `--muted`, `--ink-hover`, `--ink-disabled` | Ink makes the action and amount legible. Disabled actions remain readable but cannot imply availability. |
| Brand and secondary links | `--brass`, `--brass-light`, `--brass-bright`, `--wine` | Brass is a quiet accent and visible focus cue, not an all-purpose status color. |
| Operational meaning | `--sage[-light]`, `--amber[-light]`, `--danger[-light]` | Success, caution and error respectively; always pair color with words and/or an icon. |

Use `GH₵` and tabular numerals for prices, totals and stock. **Demo**, **staging**, **checkout locked**, **connection review** and **live** must be described in text; a green catalogue indicator alone never implies permission to trade. Verify readable contrast on each surface, including disabled actions and warnings.

## Typography

Bodoni Moda (self-hosted with Fontsource) is for page and section headings, figures, and the brand. DM Sans is for navigation, product names, controls, tables, instructions and operational labels. Use system monospace only for SKU/barcode or event identifiers. Avoid uppercase tracked micro-labels for stock or controls. At phone sizes form/search fields stay large enough to avoid browser zoom; small text is supporting context, not the only way to convey stock or payment state.

Hierarchy: one page `h1`; section `h2`; item/empty-state `h3` within its section. When there is no section heading, add one rather than skipping from `h1` to `h3`. Use concise explanatory copy directly below the relevant title or control.

## Layout

- **Counter (over 820px):** search, scanner and category filters form one collection shelf beside a viewport-sized sale cart. Three garment columns fit at 1280px; two are preferable at narrower counter widths, with four on very wide displays. The total and **Prepare order** remain visible at 1280 × 800 while cart detail scrolls independently.
- **Directory:** desktop uses a 208px labeled, grouped workroom directory, not an icon-only rail. At a short counter height its supplementary connection card yields to the actual destinations. At 1080px and below it becomes a focus-contained drawer; Escape closes it, and the off-screen drawer is hidden from focus. Active page and environment remain legible in text.
- **Phone (up to 640px):** a fixed bottom sale bar opens the full-height cart. Data tables keep semantic headers but reflow into labeled two-column records instead of hiding price, stock status, actions or access. Search and filters stack; records and long SKUs wrap. At intermediate widths, a labeled, focusable table region retains horizontal scrolling.
- **Operational sheets:** records have a section title, count, filters and semantic table in that order. Stats form one compact comparative strip (two columns at 375px, one at very narrow widths). Reports show a signed daily chart *and* expandable daily totals; an all-zero period says so rather than fabricating activity. Period, scope and export remain in view; reports cover recorded POS sales, not all web orders.
- **Task progression:** Wholesale uses a visible goods → approval → full-payment sequence and a sticky agreed-total sheet. The cash desk pairs the opening-float form with a practical procedure, while connection keeps read permissions, write gates and trading acceptance separate.

Use the actual data's length: long names, missing SKUs, zero/negative totals, no records and interrupted sales all need a complete layout. No screen may cause page-level horizontal overflow at 320px.

## Elevation & Depth

Surfaces use a one-pixel line; don't add a shadow to every card. The sticky cart (`--shadow`) and active dialogs/toasts (`--shadow-lg`) earn elevation because they layer over the workspace. The dark connection header is a status anchor, not a decorative hero. No gradients, glass or blurred containers in routine task flow. The backdrop blur belongs only to active dialogs and the navigation scrim.

## Shapes

Controls and ledger sheets use approximately 2–4px corners; dialogs 3px. Badges, avatars and stock dots remain circular/pill by function; the product add affordance is a small squared-off control. Use Lucide stroke icons consistently; icons support text, never replace a payment instruction or security state. Buttons and fields are generally at least 44px high, with visible brass keyboard focus. Native checkbox, select and focus behavior is preferable to an ornamental replacement.

## Components

- **Register/cart:** `PageHeading`, product grid, search and F2 scanner form one selling path. Category and view filters expose pressed state. Stock/backorder/shared-pool warnings stay visible; unknown connected stock is never presented as sellable. The primary CTA says **Prepare order** because it prepares a WooCommerce order, not a charge. The cart total and CTA stay visible; notes and item details can scroll.
- **Checkout/receipt:** the store-confirmed total leads. Cash needs a counted tender and explicit confirmation; MoMo/Card need an externally verified reference and confirmation. Switching method clears stale input/confirmation. The checkout decision remains in view when long quotes or fields scroll; at 1280 × 800, the confirmation and action are both visible. Recording a payment is not payment processing. Receipt width and demo watermark remain explicit and printer-safe.
- **Records/reports:** native tables within named `TableRegion` components; headers remain accessible when phone records reflow. Status is a text badge. Filters show a specific empty state with a way to clear filters. Daily bars have a zero baseline and a readable daily-totals list; never imply a net refund is a new sale.
- **Shifts/staff/audit:** cash movements use labeled type, amount and reason; counted close remains a deliberate action. Staff access is a compact role comparison, not decorative cards. Audit events have their own section heading and preserve long subjects and timestamps.
- **Connection/navigation/feedback:** show catalogue and write-gate states separately. `Notice` is inline guidance; errors use alert semantics, while a dismissible `Toast` confirms an action. Drawer, modal and data-region focus must work with a keyboard. Reduced-motion users get no animation; product/card and feedback motion never delay a sale.

## Do's and Don'ts

- **Do** preserve the existing boutique palette and garment-led counter. **Don't** copy another brand's DESIGN.md, logo, illustrations or layout verbatim.
- **Do** name actions for what they actually do and keep role, demo and live gates explicit. **Don't** claim payment was charged or a live order was approved merely because a button was clicked.
- **Do** keep the operational safeguards in `docs/SETUP.md`, `docs/ACCEPTANCE.md`, `docs/PRODUCTION.md` and the backend intact. **Don't** restyle away the locked checkout, stale-stock, reconciliation, backorder or external-payment warnings.
- **Do** test at 1280 × 800, 820px, 375px and 320px with keyboard, reduced motion, long data and empty states. **Don't** assume an axe pass alone proves a workflow or hardware is safe.
- **Do** use isolated demo data for browser walkthroughs. **Don't** mutate the shared public demo ledger or treat mocked staging as real staging acceptance. Concurrent last-item storefront/POS stock remains a release gate, not a visual-design problem.
