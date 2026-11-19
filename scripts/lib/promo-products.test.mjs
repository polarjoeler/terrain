// node --test scripts/lib/promo-products.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { parseRand, shopifyProducts, wooProducts, tidyTitle } from "./promo-products.mjs";

test("rand amounts", () => {
  assert.equal(parseRand("R 1,299.00"), 1299);
  assert.equal(parseRand("R1 299,00"), 1299);
  assert.equal(parseRand("R799"), 799);
});

test("woo: minor units, was-price, permalink", () => {
  const [p] = wooProducts([{ id: 1, slug: "braun-blender", name: "Braun &amp; Co Blender", permalink: "https://s.co.za/p/braun",
    images: [{ src: "https://s.co.za/b.jpg", thumbnail: "https://s.co.za/b-300.jpg" }],
    prices: { regular_price: "379900", sale_price: "339900", currency_minor_unit: 2, currency_code: "ZAR" } }]);
  assert.equal(p.title, "Braun & Co Blender");
  assert.equal(p.price, 3399);
  assert.equal(p.regular, 3799);
  assert.equal(p.pct, 11);
  assert.equal(p.image, "https://s.co.za/b-300.jpg");
});

test("woo: product with no image is skipped", () => {
  assert.equal(wooProducts([{ id: 2, name: "x", permalink: "https://s/x", images: [], prices: { price: "100", currency_minor_unit: 2 } }]).length, 0);
});

test("shopify: ld+json list merged with card was-prices", () => {
  const html = `<script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"@type":"ListItem","item":{"@type":"Product","name":"Balder Black","url":"https://s.co.za/products/balder-black","image":"https://cdn.shopify.com/files/b_large.jpg","offers":{"price":"795","priceCurrency":"ZAR"}}}]}</script>
  <div class="card"><a href="/products/balder-black"><img srcset="//s.co.za/cdn/shop/files/b_360x.jpg 360w"></a><span class="price-item--sale">R 795.00</span><s class="price-item--regular">R 1,699.00</s></div>`;
  const [p] = shopifyProducts(html, "https://s.co.za");
  assert.equal(p.title, "Balder Black");
  assert.equal(p.price, 795);
  assert.equal(p.regular, 1699);
  assert.equal(p.pct, 53);
  assert.equal(p.image, "https://cdn.shopify.com/files/b_540x.jpg");
});

test("shopify: cards only, badge used when there's no was-price", () => {
  const html = `<div><span>-30%</span><a href="/products/rug"><img data-srcset="//s.co.za/cdn/shop/files/r_180x.jpg 180w, //s.co.za/cdn/shop/files/r_540x.jpg 540w" alt="Meno Rug"></a><span>R199</span></div>`;
  const [p] = shopifyProducts(html, "https://s.co.za");
  assert.equal(p.title, "Meno Rug");
  assert.equal(p.price, 199);
  assert.equal(p.pct, 30);
  assert.equal(p.image, "https://s.co.za/cdn/shop/files/r_540x.jpg");
});

test("title mojibake", () => {
  assert.equal(tidyTitle("Timberland‚® Premium  Boot"), "Timberland® Premium Boot");
});
