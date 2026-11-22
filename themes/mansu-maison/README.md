# Mansu Maison: WooCommerce theme for mansutrendzgh.com

The "Maison" demo (`storefront-demos/maison.html`) built as a real WordPress theme.

WooCommerce renders every product list, product page, cart and checkout on the server.
That keeps them crawlable and working without JavaScript, and Paystack checkout is unchanged.
`assets/js/maison.js` (about 9 KB, no framework) adds search suggestions, quick view, the bag drawer and toasts on top.

## What you get

| Area | What it does |
|---|---|
| Home (`front-page.php`) | Opening with 3 photos, category tiles with counts, "New this week" rail, occasion tiles, best sellers, service notes, FAQ |
| Header | Notice bar, logo, predictive search (press `/`), account, wishlist (YITH), bag drawer, menu, Occasions mega menu |
| Shop / category / tag / search | Category buttons, sticky toolbar (count, sorting, filter), removable filter chips, 4-column grid, pagination |
| Filters | Occasion (product tags), size (`pa_size`), colour (`pa_color` with swatch colours), price bands. Each option shows how many styles it would leave. Built on WooCommerce's own URL parameters, so results are the normal paginated shop. |
| Product card | Second photo on hover, Quick view, New/Sale/Sold-out badge, colour dots. Wishlist and other loop add-ons still appear. |
| Quick view | The real WooCommerce add-to-cart form (variations, stock, swatches), added without leaving the page |
| Bag drawer | WooCommerce mini-cart with **Checkout** (Paystack) and **Order on WhatsApp**, which sends the bag as a message with sizes, colours and total |
| Product page | Gallery with zoom/lightbox, sticky summary, "Ask about this on WhatsApp", delivery/wholesale notes |
| SEO | Semantic landmarks, one `h1` per page, breadcrumbs (Rank Math's when enabled), FAQPage JSON-LD on the home page. Titles, meta, Open Graph and Product schema stay with Rank Math. |
| Accessibility | Skip link, visible focus, native `<dialog>` (focus trap, Esc), labelled icon buttons, 44px targets, `prefers-reduced-motion`, light and dark themes |
| Performance | One CSS file, one deferred script, preloaded hero image, lazy images with width/height, portrait 3:4 thumbnails, no emoji scripts |

## Install (staging first)

1. Build the ZIP: `themes/build-zip.sh`, which writes `themes/dist/mansu-maison-1.0.0.zip`.
2. On a **staging copy** of the site: Appearance → Themes → Add New → Upload Theme → choose the ZIP → Install → **Live Preview**.
   Live Preview shows the theme without switching it for customers.
3. Check the pages in the checklist below, then Activate.
4. Rolling back: Appearance → Themes → activate **Fana Child** again. Nothing in the catalogue is changed by this theme.

On activation the theme sets WooCommerce's thumbnail crop to 3:4 (WooCommerce → Settings → Products, or Customize → WooCommerce → Product Images).
WooCommerce regenerates thumbnails in the background.

## Set up (Appearance → Customize → Maison)

- **Shop details**: notice bar lines, WhatsApp number, address, and **Hide products without a photo** (on by default).
  The live catalogue has about 1,570 photo-less products, mostly one product per size. They stay for sale and keep their own pages.
- **Home: opening**: heading, introduction, 3 portrait photos with labels and links. Until photos are chosen, the newest photographed products are used.
- **Home: categories & occasions**: category slugs for the tiles and buttons (default `dresses-womens-clothing, two-piece-sets, tops-blouses, pants-jeans, abayas-kaftans`),
  and 4 occasions, each a name plus a **product tag** slug. An occasion appears once its tag has products.
  Defaults: `office`, `church-events`, `evening`, and `casual` for Weekend (113 products already carry "Casual").
- **Home: service & FAQ**: three service notes and the FAQ (`Question | Answer` per line). The FAQ is also published as structured data.
- **Menus**: assign a menu to "Main menu". Until then the header shows New in plus the category tiles' categories.

## Recommended Rank Math settings

- Titles & Meta → Homepage: set the schema type to **WebPage / CollectionPage**. The live home page currently says "Article".
- Titles & Meta → Local SEO: choose **Organization → ClothingStore** and fill in the address and phone. The theme does not duplicate this.
- General → Breadcrumbs: enable them, and the theme will show Rank Math's breadcrumbs.

## Pre-launch checklist (staging)

- [ ] Home page: photos, category counts, "New this week", best sellers
- [ ] A category page: filters by size, colour, price and occasion; chips remove filters; pagination
- [ ] Search for "trousers", "yellow" and "co-ord": suggestions appear while typing, and Enter shows results
- [ ] Quick view on a variable product: choose size and colour, add to bag, and the bag count updates
- [ ] Bag drawer → Checkout → **Paystack test payment**
- [ ] Bag drawer → Order on WhatsApp: message lists items, options and total
- [ ] Product page: gallery zoom, variation swatches, wishlist button, WhatsApp question
- [ ] Cart, Checkout, My account on a phone
- [ ] Pages built with Elementor still display
- [ ] LiteSpeed Cache: purge after activating
- [ ] Lighthouse on home, category and product pages (mobile)

## Files

```
style.css            Theme header + all styles (tokens at the top)
functions.php        Loads inc/*
inc/helpers.php      Options, WhatsApp links, icons, featured categories, occasions
inc/setup.php        Theme supports, menus, 3:4 crop on activation
inc/customizer.php   Maison settings and defaults
inc/assets.php       Fonts, CSS, JS, hero preload
inc/schema.php       FAQPage (+ ClothingStore when no SEO plugin)
inc/woocommerce.php  Layout, card helpers, fragments, WhatsApp cart message, product page extras, photo-less hiding, search synonyms
inc/filters.php      Filter drawer, live option counts, chips
inc/ajax.php         wc-ajax: mansu_search, mansu_quick_view, mansu_add_to_cart
woocommerce/         archive-product.php and content-product.php overrides
assets/js/maison.js  Front-end behaviour
```
