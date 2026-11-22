#!/usr/bin/env python3
"""Build the three storefront demos.

src/<name>.html holds a head block (between <!--HEAD--> and <!--/HEAD-->) and the body.
This script injects the product data, the shared core script and JSON-LD, then writes:
  <name>.html          a full HTML document (open directly in a browser)
  dist/<name>.html     the same page without the document skeleton (for the artifact host)
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent
SITE = "https://www.mansutrendzgh.com"
DEMOS = ["maison", "rail", "tudu"]

products = json.loads((ROOT / "products.json").read_text())
core = (ROOT / "src/core.js").read_text()

FAQ = [
    ("Do you deliver outside Accra?",
     "Yes. We deliver across Ghana. Send your order and location on WhatsApp and we confirm the delivery cost for your area."),
    ("Can I buy wholesale for my boutique?",
     "Yes. Mansutrendzgh sells wholesale and retail. Message +233 54 539 6555 on WhatsApp with the styles and quantities you want and we send wholesale prices."),
    ("Where is your showroom?",
     "Amu Wrist Ln 35, Accra, near Tudu Market. You can see and try current stock in person."),
    ("How do I choose my size?",
     "Most styles come in S, M and L, and some in XL to 3XL or a free size. Each product lists the sizes we stock. If you are between sizes, ask us on WhatsApp for the garment's measurements."),
    ("How do I place an order?",
     "Add pieces to your bag and send the order to us on WhatsApp, or check out on the website. Our showroom and website share one stock count, so what you see online is what we have."),
]


def jsonld():
    store = {
        "@type": "ClothingStore", "@id": SITE + "/#store", "name": "Mansutrendzgh", "url": SITE + "/",
        "image": SITE + "/wp-content/uploads/2026/11/photo_2026-11-16_14-40-21.jpg",
        "description": "Women's clothing, wholesale and retail, in Accra with delivery across Ghana.",
        "telephone": "+233545396555", "email": "mansutrendzgh1@gmail.com",
        "address": {"@type": "PostalAddress", "streetAddress": "Amu Wrist Ln 35", "addressLocality": "Accra",
                    "addressRegion": "Greater Accra", "addressCountry": "GH"},
        "areaServed": {"@type": "Country", "name": "Ghana"}, "currenciesAccepted": "GHS",
        "priceRange": "GH₵ %d–%d" % (min(p["price"] for p in products), max(p["price"] for p in products)),
    }
    site = {"@type": "WebSite", "@id": SITE + "/#website", "url": SITE + "/", "name": "Mansutrendzgh",
            "publisher": {"@id": SITE + "/#store"}, "inLanguage": "en-GH",
            "potentialAction": {"@type": "SearchAction",
                                "target": SITE + "/?s={search_term_string}&post_type=product",
                                "query-input": "required name=search_term_string"}}
    items = {"@type": "ItemList", "name": "Women's clothing at Mansutrendzgh", "numberOfItems": len(products),
             "itemListElement": [{
                 "@type": "ListItem", "position": i + 1,
                 "item": {"@type": "Product", "name": p["name"], "url": p["url"], "category": p["cat"],
                          "image": p["full"], "color": ", ".join(p["colours"]),
                          "brand": {"@type": "Brand", "name": "Mansutrendzgh"},
                          "offers": {"@type": "Offer", "price": p["price"], "priceCurrency": "GHS",
                                     "availability": "https://schema.org/InStock", "url": p["url"],
                                     "seller": {"@id": SITE + "/#store"}}}}
                 for i, p in enumerate(products)]}
    faq = {"@type": "FAQPage", "mainEntity": [
        {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in FAQ]}
    crumbs = {"@type": "BreadcrumbList", "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Home", "item": SITE + "/"},
        {"@type": "ListItem", "position": 2, "name": "Shop", "item": SITE + "/shop/"}]}
    data = {"@context": "https://schema.org", "@graph": [store, site, items, faq, crumbs]}
    return '<script type="application/ld+json">' + json.dumps(data, ensure_ascii=False) + "</script>"


def main():
    full_imgs = json.loads((ROOT / "products.full.json").read_text())
    for p in products:
        p["full"] = full_imgs.get(str(p["id"]), SITE)
    ld = jsonld()
    client = [{k: v for k, v in p.items() if k != "full"} for p in products]
    data_js = "const PRODUCTS = " + json.dumps(client, ensure_ascii=False, separators=(",", ":")) + ";\n" + \
              "const FAQ = " + json.dumps(FAQ, ensure_ascii=False) + ";\n"
    (ROOT / "dist").mkdir(exist_ok=True)
    for name in (sys.argv[1:] or DEMOS):
        src = (ROOT / f"src/{name}.html").read_text()
        head, body = src.split("<!--/HEAD-->", 1)
        head = head.replace("<!--HEAD-->", "").replace("<!--@JSONLD-->", ld).strip()
        body = body.replace("/*@CORE*/", data_js + core).strip()
        (ROOT / f"{name}.html").write_text(
            '<!doctype html>\n<html lang="en-GH">\n<head>\n<meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
            f"{head}\n</head>\n<body id=\"top\">\n{body}\n</body>\n</html>\n")
        (ROOT / f"dist/{name}.html").write_text(f"{head}\n<div id=\"top\"></div>\n{body}\n")
        print("built", name)


if __name__ == "__main__":
    main()
