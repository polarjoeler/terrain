// node --test scripts/lib/woo-confirm.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { judgeCatalogue, isPlaceholderName } from "./woo-confirm.mjs";

const p = (name, price, ccy = "ZAR", buy = true) => ({ name, is_purchasable: buy, prices: { price: String(price), currency_code: ccy } });

test("a priced, buyable ZAR catalogue is a store", () => {
  const j = judgeCatalogue([p("Rooibos Balm", 23900), p("Day Cream", 18900), p("Gift Box", 0)], "ZA");
  assert.equal(j.verdict, "store");
  assert.equal(j.buyable, 2);
  assert.equal(j.currency, "ZAR");
});

test("quote-only B2B catalogue (price 0, no buy button) is quote_only (publishes as a no-checkout lead)", () => {
  assert.equal(judgeCatalogue([p("400L Digital Oven", 0), p("Gasket Set", 0), p("Toner", 0, "ZAR", false)], "ZA").verdict, "quote_only");
  // catalogue mode: prices shown in rand, nothing purchasable
  const j = judgeCatalogue([p("Pallet Racking", 125000, "ZAR", false), p("Shelf Beam", 34000, "ZAR", false)], "ZA");
  assert.equal(j.verdict, "quote_only");
  assert.equal(j.currency, "ZAR");
});

test("a quote-only catalogue priced in a foreign currency is an imported demo, not a lead", () => {
  assert.equal(judgeCatalogue([p("Pallet Racking", 12500, "USD", false), p("Shelf Beam", 3400, "USD", false)], "ZA").verdict, "wrong_currency");
});

test("WooCommerce sample data and lorem products are a demo, even with prices", () => {
  assert.equal(judgeCatalogue([p("Hoodie with Logo", 4500), p("WordPress Pennant", 1105), p("Beanie", 2000)], "ZA").verdict, "demo");
  assert.equal(judgeCatalogue([p("Lorem Ipsum 4", 20000), p("Henectus tincidunt", 42900)], "ZA").verdict, "demo");
  assert.equal(judgeCatalogue([p("Test product 1", 0), p("Sample product", 100)], "ZA").verdict, "demo");
});

test("a ZA site priced in USD/GBP is a foreign demo import, not a ZA store", () => {
  assert.equal(judgeCatalogue([p("Agyness", 11995, "GBP"), p("Marlowe", 9900, "GBP")], "ZA").verdict, "wrong_currency");
});

test("a market without a currency rule only needs buyable products", () => {
  assert.equal(judgeCatalogue([p("Item A", 100, "XOF"), p("Item B", 200, "XOF")], "SN").verdict, "store");
});

test("one real product is too small to call a store; nothing is empty", () => {
  assert.equal(judgeCatalogue([p("Only Thing", 5000)], "ZA").verdict, "tiny");
  assert.equal(judgeCatalogue([], "ZA").verdict, "empty");
  assert.equal(judgeCatalogue(null, "ZA").verdict, "empty");
});

test("placeholder detection decodes entities and ignores real product names", () => {
  assert.equal(isPlaceholderName("Hoodie with Logo"), true);
  assert.equal(isPlaceholderName("Lorem&#8217;s Ipsum"), true);
  assert.equal(isPlaceholderName("Reverse Osmosis Hot &#038; Cold Water Stand"), false);
  assert.equal(isPlaceholderName("Test Kit for Pool Water"), true); // conservative: "test…" names are skipped
});

import { isHoldingPage, tidyName } from "./woo-confirm.mjs";
test("coming-soon and maintenance homepages are caught; a normal shop is not", () => {
  assert.equal(isHoldingPage("<title>MadAnt Computers - Cape Town is under construction</title>"), true);
  assert.equal(isHoldingPage('<title>Boland</title><link href="/wp-content/plugins/coming-soon/public/css/seedprod.css">'), true);
  assert.equal(isHoldingPage("<title>Animix | Pet Food</title><a href='/shop/'>Shop</a>"), false);
});
test("names lose dangling separators and holding-page tails", () => {
  assert.equal(tidyName("Zimple Web -"), "Zimple Web");
  assert.equal(tidyName("Boland Brand Solutions is coming soon"), "Boland Brand Solutions");
  assert.equal(tidyName("Littera Books &amp; Bibles"), "Littera Books & Bibles");
});

test("tidyName rejects names with no letters", () => {
  assert.equal(tidyName("&rarr;"), null);
  assert.equal(tidyName(" | "), null);
  assert.equal(tidyName("Zimple Web -"), "Zimple Web");
});
