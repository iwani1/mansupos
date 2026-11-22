# Mansu Rosé: WooCommerce theme for mansutrendzgh.com

The "Rosé" demo (`storefront-demos/rose.html`) built as a real WordPress theme. It is a sibling of
**Mansu Maison**: the same server-rendered WooCommerce shop, filters, quick view, bag drawer, WhatsApp
ordering and Paystack checkout, with the Rosé look and a **Style Finder** on the home page.

WooCommerce renders every product list, product page, cart and checkout on the server, so they are
crawlable and work without JavaScript. `assets/js/rose.js` (no framework) adds the Finder's live counts,
search suggestions, quick view, the bag drawer and toasts.

## What you get

| Area | What it does |
|---|---|
| Home (`front-page.php`) | Heading with two photos, the **Style Finder**, category circles with counts, New this week, Best sellers, three promise cards, FAQ |
| Style Finder (`inc/finder.php`) | Three questions: occasion (product tags), size (`pa_size`), budget (price bands). Every answer shows how many styles it would leave, and answers that lead nowhere are greyed out. Tap an answer again to clear it. "Show N looks" opens the normal shop with those filters, e.g. `/?post_type=product&product_tag=office&filter_size=m&query_type_size=or&max_price=299` |
| Header | Notice bar, logo, predictive search (press `/`), account, wishlist (YITH), bag drawer, menu, Occasions menu |
| Shop / category / tag / search | Category buttons, toolbar (count, sorting, filter), removable filter chips, 4-column grid of white rounded cards, pagination |
| Filters | Occasion, size, colour and price, each option with a live count (same as Maison) |
| Product card | Second photo on hover, New / Sale / Sold-out badge, colour dots, **Choose size** (variable) or **Add to bag** (simple) opening quick view. YITH wishlist and other loop add-ons still appear |
| Quick view, bag, product page, cart, checkout, account | As Maison, restyled: rounded cards and pill buttons |
| SEO | Semantic landmarks, one `h1` per page, breadcrumbs (Rank Math's when enabled), FAQPage JSON-LD. Titles, meta, Open Graph and Product schema stay with Rank Math |
| Accessibility | Skip link, visible focus, native `<dialog>`, labelled icon buttons, 44px targets, Finder as real radio buttons in fieldsets with an `aria-live` count, `prefers-reduced-motion`, light and dark themes |
| Performance | One CSS file, one deferred script, preloaded first photo, lazy images with width/height. Finder counts are cached for 30 minutes and the endpoint sends `Cache-Control: public, max-age=300` |

Colours follow the Rosé design system: rose `#BE185D` for actions (6.0:1 on white), slate text, a pale
rose ground and amber `#D97706` for badges. Amber is only used behind dark text, because as text it is below 4.5:1.

## Install (Live Preview first)

1. Build the ZIP: `themes/build-zip.sh mansu-rose`, which writes `themes/dist/mansu-rose-1.0.0.zip`.
2. Appearance → Themes → Add New → Upload Theme → choose the ZIP → Install. **Do not activate yet.**
3. Click **Live Preview**. It shows Rosé to you only, while customers keep seeing the current theme.
4. Go through the checklist below in the preview, then **Activate**.
5. Purge LiteSpeed Cache after activating.
6. Rolling back: Appearance → Themes → activate **Mansu Maison** again. Rosé changes no products, orders or Maison settings.

On first activation Rosé copies Maison's settings (WhatsApp number, address, categories, occasions,
photos, service notes, FAQ, menus and logo) so it opens with the same content. Its own heading text is
kept. Theme settings are stored per theme, so Maison's settings stay as they were.

## Set up (Appearance → Customize → Rosé)

The same sections as Maison, plus:

- **Home: opening**: heading, italic ending, introduction, the **Style Finder heading and introduction**, and 2 portrait photos.
  Until photos are chosen, the newest photographed products are used.
- **Home: categories & occasions**: the occasions are also the Finder's first question. An occasion appears once its product tag has products.

## Pre-launch checklist (Live Preview or staging)

- [ ] Home: both photos, Finder counts, category circles with counts, New this week, Best sellers
- [ ] Finder: pick an occasion, size and budget; the counts change and dead ends grey out; tap an answer again to clear it
- [ ] Finder: "Show N looks" lands on the shop with the same chips and the same number of styles
- [ ] Finder without JavaScript (browser setting): the form still submits to the filtered shop
- [ ] A category page: filters, chips, sorting, pagination
- [ ] Search "trousers", "yellow", "co-ord": suggestions while typing, Enter shows results
- [ ] Quick view on a variable product: choose size and colour, add to bag, bag count updates
- [ ] Bag drawer → Checkout → **Paystack test payment**
- [ ] Bag drawer → Order on WhatsApp: the message lists items, options and total
- [ ] Product page: gallery zoom, variation swatches, wishlist heart, WhatsApp question
- [ ] Cart, Checkout, My account on a phone; dark mode
- [ ] Pages built with Elementor still display
- [ ] Lighthouse (mobile) on home, category and product pages

Note: Finder size counts read the size terms on each product. The shop's size filter also checks
variation stock, so for a product whose only size-M variation is sold out, the Finder may count one
more style than the shop shows.

## Files

```
style.css            Theme header, tokens, shared base, then the Rosé layer
functions.php        Loads inc/*
inc/finder.php       Style Finder form, counts and ?wc-ajax=mansu_finder
inc/helpers.php      Options, WhatsApp links, icons, featured categories, occasions
inc/setup.php        Theme supports, menus, 3:4 crop, copy Maison settings on first switch
inc/customizer.php   Rosé settings and defaults
inc/assets.php       Fonts (Playfair Display + Inter), CSS, JS, photo preload
inc/schema.php       FAQPage (+ ClothingStore when no SEO plugin)
inc/woocommerce.php  Layout, cards, fragments, WhatsApp cart message, photo-less hiding, search synonyms
inc/filters.php      Filter drawer, live option counts, chips
inc/ajax.php         wc-ajax: mansu_search, mansu_quick_view, mansu_add_to_cart
woocommerce/         archive-product.php and content-product.php overrides
assets/js/rose.js    Front-end behaviour
```
