// node --test scripts/lib/woo-catalog.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { toProduct, wooBrand } from "./woo-catalog.mjs";
import { buildVendors } from "./catalog-fp.mjs";

const p = (name, brands) => ({ name, slug: name.toLowerCase().replace(/\W+/g, "-"), sku: "", prices: { price: "89900", currency_minor_unit: 2 }, images: [], brands });

test("Woo core Brands become the Shopify-shaped vendor", () => {
  assert.equal(toProduct(p("Springboks jersey", [{ id: 324, name: "Nike", slug: "nike" }])).vendor, "Nike");
});

test("no brands field, or an empty one, is unknown — never a guess", () => {
  assert.equal(toProduct(p("Bulls 3rd kit", [])).vendor, "");
  assert.equal(toProduct(p("Bulls 3rd kit", undefined)).vendor, "");
  assert.equal(wooBrand({ brands: [{ name: "  " }] }), "");
});

test("brand names arrive HTML-escaped like titles and are decoded", () => {
  assert.equal(wooBrand({ brands: [{ name: "Hill&#8217;s Pet Nutrition" }] }), "Hill’s Pet Nutrition");
  assert.equal(wooBrand({ brands: [{ name: "Marks &amp; Spencer" }] }), "Marks & Spencer");
});

test("first named brand wins when a product carries several", () => {
  assert.equal(wooBrand({ brands: [{ name: "" }, { name: "Puma" }, { name: "Nike" }] }), "Puma");
});

test("buildVendors counts Woo products per brand and skips brandless ones", () => {
  const vs = buildVendors([
    toProduct(p("A", [{ name: "Nike" }])), toProduct(p("B", [{ name: "Nike" }])),
    toProduct(p("C", [{ name: "Puma" }])), toProduct(p("D", [])),
  ]);
  assert.deepEqual(vs.map((v) => [v.vendor, v.n]), [["Nike", 2], ["Puma", 1]]);
});
