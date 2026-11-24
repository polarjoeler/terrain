import test from "node:test";
import assert from "node:assert/strict";
import { priceFromPage } from "./price-from-page.mjs";
test("WooCommerce ld+json nests the price in priceSpecification", () => {
  const h = `<script type="application/ld+json">{"@type":"Product","offers":[{"@type":"Offer","priceSpecification":[{"@type":"UnitPriceSpecification","price":"1049.99"}]}]}</script>`;
  assert.equal(priceFromPage(h).price, 1049.99);
});
test("Woo's &#82; rand sign is not read as a price", () => {
  const h = `<p class="price"><span class="woocommerce-Price-amount"><bdi><span class="woocommerce-Price-currencySymbol">&#82;</span>750.00</bdi></span></p>`;
  assert.equal(priceFromPage(h).price, 750);
});
test("Shopify og price meta", () => {
  assert.equal(priceFromPage(`<meta property="og:price:amount" content="1,699.00">`).price, 1699);
});
test("ld+json @graph", () => {
  assert.equal(priceFromPage(`<script type="application/ld+json">{"@graph":[{"@type":"Product","offers":{"price":"95"}}]}</script>`).price, 95);
});
