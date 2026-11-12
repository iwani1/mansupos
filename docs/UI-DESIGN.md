# MansutRENDZGH Retail Studio — UI design

## Direction

The interface is an **editorial boutique workspace**, not a generic SaaS admin theme. It is designed for a fashion retailer: garment imagery leads, the cart stays persistent, and operational screens use the same quiet, premium language.

Visual system:

- Warm ivory paper and deep aubergine-black ink.
- Restrained brass accents; sage/amber/red only for operational meaning.
- Bodoni Moda display serif for headings and brand moments; DM Sans for product names and operational text.
- Readable, grouped workroom directory on desktop; focus-contained drawer navigation on tablet/mobile.
- Product-first grid with illustrative demo imagery, minimal chrome, and clear price/stock hierarchy.
- Persistent, high-contrast cart and checkout total.
- Receipt styling that matches the brand while remaining printer-safe.

## Research reviewed

- Shopify, “Shopify POS: Designed for Your Brand, Built for Modern Retail” — brand theming, more line items in view, prominent checkout totals, vertical navigation, and scoped search. https://shopify.com/retail/shopify-pos-design-update
- Dribbble fashion POS search results, including Rakun POS by S. Andreans and mixmatch by Caraka — narrow tool rails, garment-led tiles, and a separate order/payment panel. https://dribbble.com/search/pos-fashion-ui
- Behance POS project search — reviewed for retail/fashion POS layout patterns; no assets copied. https://www.behance.net/search/projects/point%20of%20sale
- MansutRENDZGH public storefront — confirmed women’s fashion / in-store collection positioning. https://www.mansutrendzgh.com/
- MotionSites.ai premium motion gallery — inspiration for editorial entrances, staggered reveals and tactile feedback; no artwork, prompts, or code copied. https://motionsites.ai/
- **Unslop**, by Damir Sokolovsky — reviewed 5 November 2026 for its product-specific, layered visual-audit approach. The skill is licensed CC BY 4.0; attribution: Damir Sokolovsky ([@heydamir](https://x.com/heydamir)), https://github.com/heydamir/unslop. Its methodology informed this pass; no skill scripts, assets or dependency were installed in the POS.

The redesign adapts usability principles; it does not copy reference artwork, logos, or product photography. Demo product images remain explicitly labelled illustrations. Connected environments use WooCommerce image URLs.

## Unslop-informed audit and polish — 5 November 2026

**Direction:** A selling and stock workspace for a boutique counter; composed, tactile and quick; rooted in warm paper, ink and garment photography. Product imagery and the current-sale total carry the emphasis. The existing MansutRENDZGH wordmark, brass accents, compact rail and editorial headings remain the visual signature.

| Audit observation | Refinement |
| --- | --- |
| On a 1280 × 800 counter screen, the charge button and profile control extended below the viewport. | Start the cart beside the register heading, size it to the viewport, keep its charge action outside the scrollable details, and compact/scroll the navigation independently. Error notices scroll into view and announce themselves. |
| Stock, category, table, badge and form text was often 8–10 px, especially on mobile; operational labels used widely tracked uppercase. | Raise operational text sizes, use sentence case and a clearer sans-serif product/stock hierarchy, while keeping the serif headings and existing palette. Controls for scanning, refreshing and cart quantities have larger touch areas. |
| A 1280 px screen showed only two oversized product columns; the scanner was separated from search. | Use three product columns at that width, a shorter image proportion, and place scanning beside product search. The card remains the add-to-sale target. |
| At 320 px, the stock filter disappeared and some page headers overflowed horizontally. A toast could cover the mobile charge action. | Keep the stock filter and scanner visible, stack small-screen report/page actions, and move cart-open notifications away from the charge button. Tables retain their own horizontal scrollers. |
| Demo product parents could appear selectable after every option sold out. The scanner example could point to a depleted size. Mixed attributes were called sizes, and live variation stock could be double-counted when options share parent stock. | Base product availability on its options; label backorders and prompt staff when the customer should be notified; exclude backorder-only items from the physical-stock filter; suggest an available demo barcode; use generic option labels where appropriate. Identify parent-shared quantities, count them once in inventory, and avoid presenting unknown ownership or old cached live rows without ownership metadata as untracked or sellable. A removed option cannot silently turn into an invalid cart line. WooCommerce remains authoritative at checkout. |
| Empty report days looked like full-height placeholder bars, and longer periods could crowd the graph. | Use a zero baseline, proportional positive/negative bars, a dense 30/90-day layout and an expandable, keyboard-accessible list of daily values. The report still covers POS records only. |
| The interface included unsupported “Accra flagship” copy and decorative or looping movement on inactive elements. | Use “Main store”, simplify secondary labels, remove decorative stat icons and perpetual empty-state motion, and retain short motion for state changes. |

`tests/browser-design.mjs` exercises counter-sized viewport visibility, responsive overflow, touch targets, error visibility, stock/backorder/variation states, shared-pool cart limits, inventory totals and report values using intercepted demo responses. It also simulates an unapproved staging **UI** while the server remains in demo mode. Real staging data, hardware and live deployment remain untested.

## Motion layer

The POS keeps the MotionSites-inspired motion layer, tuned for a working register:

- Product cards reveal with a short stagger; hover uses a small lift and restrained image movement.
- Cart lines and totals confirm changes with short rise/pulse animations.
- Prepare-order arrow feedback, dialogs, toasts, notices and selected options use short transitions and a consistent ease-out curve; routine operational pages no longer stage card-by-card entrances.
- Decorative infinite movement is removed; the loading spinner remains animated while work is in progress.
- All motion is CSS-only, avoids layout shift, and never gates checkout.
- `prefers-reduced-motion: reduce` disables animations and transitions globally; print also disables motion.
- `tests/browser-motion.mjs` verifies motion is present by default and fully disabled under reduced motion.

## Usability rules

- Checkout total and primary action remain visible in the cart at tested counter sizes.
- Search supports product names, SKU and barcode; scanner shortcut remains `F2`.
- Variation selection shows per-option availability, including size when size is the only attribute.
- Demo/live/staging state is always visible.
- Payment recording is visually distinct from payment processing.
- Tables, reports, shifts, and staff screens share the same tokens and controls. Phone-width records reflow without concealing actions or stock status; intermediate-width tables retain a keyboard-focusable horizontal scroller.
- Mobile uses a bottom cart bar and full-height cart drawer; horizontal overflow is tested.
- Focus states, skip link, reduced motion, and print rules are preserved.

## Whole-POS refinement — DESIGN.md collection and Impeccable guidance

The [awesome-design-md collection](https://github.com/voltagent/awesome-design-md) was used for pattern-level documentation ideas from its Oura, Notion, Nike and Shopify examples; it is not a single theme. [Impeccable](https://github.com/pbakaus/impeccable) was used as a read-only design-review guide for task completion, hierarchy, responsive composition, states and accessibility. No third-party assets, scripts, skill installer, hooks or approval-bypassing action were added. Root [`DESIGN.md`](../DESIGN.md) records the actual Mansu tokens and interaction rules for future work; it does not replace this design history.

A desktop-and-phone review of all eight POS screens highlighted hidden mobile table columns, long report/staff stacks, and two axe gaps: a non-focusable horizontal scroller and an `h1`→`h3` jump on the empty audit page. The refinement:

- Reflows sales, inventory, top products, shifts, staff and audit tables into labeled phone-width records, keeping the same semantic table and column headings. At intermediate widths the named table region is keyboard reachable. Inventory exposes price, available/shared stock, state and full SKU; staff exposes access actions.
- Condenses the staff role guide and 375px report metrics, makes form/search controls easier to use on phones, and gives audit events a proper section heading. Report method bars use positive net values as a bounded denominator, while signed daily totals remain readable in the expandable list.
- Uses **Prepare order** before the payment step rather than implying this POS charges a customer. Selected category/view/variant/payment controls expose pressed state; switching payment method clears stale amount/reference and confirmation. Mobile navigation and cart drawers restore focus and support Escape; error toasts announce promptly.
- Separates catalogue state from write permission in the topbar/connection page: a synced catalogue does not imply checkout approval. The connection guide explicitly retains the concurrent last-item stock release gate.
- Leaves WooCommerce stock ownership, idempotency/reconciliation, external payment verification, demo isolation, receipt printing and the server-side live write gate intact.

The browser/accessibility checks use an **isolated** demo directory; none of these UI results proves real staging, actual peripherals or the WooCommerce-side concurrent-stock protection needed before live trading.

## Counter / ledger — whole-workspace layout

This iteration applies the existing design recommendations to the entire POS, not just the register. The palette, self-hosted typography, product imagery and operational language remain Mansu's; `src/studio.css` composes the new layouts after the base styles. There are no decorative stock photos, gradients, dashboard hero tiles, new checkout permissions or changes to WooCommerce order logic.

- **Directory and masthead:** replace the narrow desktop icon rail with a 208px labeled workroom directory, grouped into counter and studio destinations. The current store/page and explicit environment state live in the masthead. On short displays, remove the supplemental connection card so every destination and the profile remain reachable; the 1080px drawer still traps focus and closes on Escape.
- **Counter:** collect search, scanner, categories and stock/view filters on a single collection shelf. Merchandise remains a three-column line sheet at 1280px, two columns on phone. The aubergine sale header, independent item scroll, tabular total and fixed prepare-order action make the current sale legible without mistaking a demo/cart reference for a charge.
- **Orders and stock:** give Sales and Inventory named record sections, a count and scoped filters. Use one comparative metric strip instead of separate raised cards. Preserve shared-parent-stock language, private wholesale price visibility by role, labeled phone records, missing SKU flags and reconciliation actions.
- **Wholesale and cash:** express the goods → review → full-payment sequence as a clear order form, with a contrasting agreed total. Pair the shift opening form with concise cash-desk procedure; keep counted close and interrupted-order cautions. Checkout's confirmation and action fit at a 1280 × 800 counter height; longer quote bodies scroll beneath a visible footer. Receipt print output is unchanged.
- **Reports, staff, audit, connection and physical collection:** shorten the daily graph without hiding signed values or the expandable ledger; an all-zero period says no POS sales. Role permissions remain comparative, audit entries remain a semantic table, and connection still distinguishes catalogue reads, write gates and last-item trading acceptance. The separate physical collection retains its legacy-source warning and retired-cash restrictions.
- **Phone:** at 375px metrics form two readable columns, while very narrow widths stack them. Cart/drawer controls, stock and locked-state wording stay visible; no page-level horizontal overflow at 320px. Motion remains short and respects reduced motion.

Visual review used isolated demo desktop (1280 × 800) and phone (375 × 812) screenshots for every route, plus a payment dialog at counter height. `tests/browser-design.mjs` now checks that desktop navigation destinations fit, the wholesale total has usable contrast and 375px report metrics do not turn into a long single column. `tests/browser.mjs` checks that payment confirmation and its action fit at 1280 × 800; the pilot browser check requires the full read-only warning on a phone. Browser walkthroughs use an isolated `POS_DATA_DIR`; these results cannot approve live trading, deploy to Contabo or prove concurrent WooCommerce stock safety.
