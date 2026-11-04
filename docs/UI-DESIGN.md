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

The redesign adapts usability principles; it does not copy reference artwork, logos, or product photography. Demo product images remain explicitly labelled illustrations.

## Usability rules

- Checkout total and primary action remain visible in the cart.
- Search is product/SKU focused; scanner shortcut remains `F2`.
- Variation selection shows per-size availability.
- Demo/live/staging state is always visible.
- Payment recording is visually distinct from payment processing.
- Tables, reports, shifts, and staff screens share the same tokens and controls.
- Mobile uses a bottom cart bar and full-height cart drawer; horizontal overflow is tested.
- Focus states, skip link, reduced motion, and print rules are preserved.
