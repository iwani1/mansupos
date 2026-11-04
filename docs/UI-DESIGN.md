# MansutRENDZGH Retail Studio — UI redesign

## Direction

The interface is an **editorial boutique workspace**, not a generic SaaS admin theme. It is designed for a fashion retailer: garment imagery leads, the cart stays persistent, and operational screens use the same quiet, premium language.

Visual system:

- Warm ivory paper and deep aubergine-black ink.
- Restrained brass accents; sage/amber/red only for operational meaning.
- Bodoni Moda display serif for headings and brand moments; DM Sans for dense operational text.
- Narrow icon-and-label navigation rail on desktop; full drawer navigation on tablet/mobile.
- Product-first grid with large portrait imagery, minimal chrome, and clear price/stock hierarchy.
- Persistent, high-contrast cart and checkout total.
- Receipt styling that matches the brand while remaining printer-safe.

## Research reviewed

Reviewed 4 November 2026:

- Shopify, “Shopify POS: Designed for Your Brand, Built for Modern Retail” — brand theming, more line items in view, prominent checkout totals, vertical navigation, and scoped search. https://shopify.com/retail/shopify-pos-design-update
- Dribbble fashion POS search results, including Rakun POS by S. Andreans and mixmatch by Caraka — narrow tool rails, garment-led tiles, and a separate order/payment panel. https://dribbble.com/search/pos-fashion-ui
- Behance POS project search — reviewed for retail/fashion POS layout patterns; no assets copied. https://www.behance.net/search/projects/point%20of%20sale
- MansutRENDZGH public storefront — confirmed women’s fashion / in-store collection positioning. https://www.mansutrendzgh.com/
- MotionSites.ai premium motion gallery — reviewed for editorial entrance motion, staggered reveals, tactile hover states, and ambient depth. Used as inspiration only; no MotionSites artwork, prompts, or code were copied. https://motionsites.ai/

The redesign adapts usability principles; it does not copy reference artwork, logos, or product photography. Demo product images remain explicitly labelled illustrations.

## Motion layer

The POS uses a restrained MotionSites-inspired motion layer rather than a marketing-site animation stack:

- Product cards reveal with a short stagger; hover lifts the tile and gently scales imagery.
- Cart lines and totals confirm changes with small rise/pulse animations.
- The charge button has a tactile hover sheen; dialogs, toasts, notices, and selected payment/size options use spring-like entrances.
- Login and empty/scanner states use subtle ambient movement, while operational screens stay calm.
- All motion is CSS-only, avoids layout shift, and never gates checkout.
- `prefers-reduced-motion: reduce` disables animations and transitions globally; print also disables motion.
- `tests/browser-motion.mjs` verifies motion is present by default and fully disabled under reduced motion.

## Usability rules

- Checkout total and primary action remain visible in the cart.
- Search is product/SKU focused; scanner shortcut remains `F2`.
- Variation selection shows per-size availability.
- Demo/live/staging state is always visible.
- Payment recording is visually distinct from payment processing.
- Tables, reports, shifts, and staff screens share the same tokens and controls.
- Mobile uses a bottom cart bar and full-height cart drawer; horizontal overflow is tested.
- Focus states, skip link, reduced motion, and print rules are preserved.
