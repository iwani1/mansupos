# Storefront redesign demos

Six directions for the mansutrendzgh.com storefront, built on the real catalogue
(41 photographed products pulled from the public WooCommerce Store API on 22 Nov 2026).
Open any `<name>.html` file directly in a browser.

| Demo | Direction | Best at |
|---|---|---|
| **1 · Maison** | Editorial, image-led, serif display type, gold accent | Brand perception, browsing, premium feel |
| **2 · Rail** | Search-first, sticky facet sidebar, quick-add sizes on cards | Finding a specific item fast, conversion |
| **3 · Tudu** | Phone-first, occasion "stories", bottom tab bar, retail/wholesale switch | Instagram/WhatsApp mobile traffic, boutique buyers |
| **4 · Atelier** | Swiss 12-column grid, every filter visible, grid/list (table) view toggle | Comparing many styles at once, wholesale buyers |
| **5 · Edit** | Brutalist editorial bento, hard borders, inline search tile, one-tap filter bar | A bold, fashion-forward brand image |
| **6 · Rosé** | Soft boutique, 3-step Style Finder (occasion → size → budget), saved styles | Undecided shoppers; guided discovery |
| **7 · Rail + Finder** | Rail's search page with Rosé's Style Finder above the results; both drive one filter state | Serving shoppers who search and shoppers who browse, on one page |

Demos 4–6 follow design systems from the UI/UX Pro Max skill: "Minimalism & Swiss" (near-black + gold
`#A16207`, Cormorant/Montserrat), "Brutalism" editorial black + pink (Syne/Manrope "Fashion Forward"),
and fashion rose `#BE185D` + gold (Playfair Display/Inter "Classic Elegant"). Accent colours below 4.5:1
on white (`#EC4899`, `#D97706`) are used only as fills behind dark text.

All six share `src/core.js`: synonym-aware search (trousers → pant, church, colours), faceted
filtering with live counts, a bag kept in the browser, and a one-tap WhatsApp order message.
Shareable filtered views use hashes such as `#cat-dresses`, `#occ-office` and `#new`.

## Build

```bash
python3 build.py
```

Edit `src/*.html` or `src/core.js`, then rebuild. `products.json` is the curated catalogue,
and `img/` holds 480×638 WebP thumbnails (about 23 KB each).

## What the audit of the live site found

1. **Catalogue duplication.** 1,694 products, but 1,572 have no photo. Most are one product per
   size ("Zara Pink Cotton Top — Size L", "PEACH COTTON SET L — Store ref 1567"). These thin,
   near-duplicate pages dilute SEO and bury the photographed styles.
2. **Duplicate categories.** Dresses ×2, Shirt ×3, Pants ×2, Skirt ×2, plus "Uncategorized (111)"
   and products filed in the wrong category (a fan and a pearl shirt under Dresses).
3. **Template copy left in place.** "Women's beachwear", "We deliver goods around the world",
   "fabrics from Turkey, India, Italy", 2022 blog archives, and "Copyright @ 2026 iwan".
4. **No product discovery tools.** No filters by size, colour, occasion or price.

## SEO and accessibility built into the demos

- Semantic landmarks (`header`, `nav`, `main`, `section`, `article`, `footer`), one `h1`, breadcrumbs.
- JSON-LD: `ClothingStore` (address, phone, area served), `WebSite` with `SearchAction`,
  `ItemList` of `Product`/`Offer` in GHS, `FAQPage`, `BreadcrumbList`.
- Title, meta description, canonical, Open Graph, Twitter card, `en-GH` locale.
- Width and height on every image, lazy loading below the fold, a preloaded hero image, WebP, no JS framework.
- Skip link, visible focus, native `<dialog>` (focus trapping), an ARIA 1.2 combobox for search (demo 2),
  `aria-live` result counts, 44 px touch targets, `prefers-reduced-motion`, light and dark themes.

## Rolling the chosen demo out on WordPress

1. Merge size-variant products into variable products (one page per style, sizes as variations),
   and 301-redirect the old URLs. Without this, no theme will fix discoverability or SEO.
2. Collapse categories to the five in the demos, and add an `occasion` attribute for filtering.
3. Build the chosen design as a block theme or child theme, so product grids are rendered
   server-side by WooCommerce (crawlable). Then add the search and filter script on top.
4. Use Rank Math (already installed) for the Product and Organization schema shown here,
   and give each category its own intro copy (demo 2 shows examples).
