// node --test scripts/lib/catalog-fp.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { scorePair } from "./catalog-fp.mjs";

const fp = (n, { sku = true, price = true, img = n, off = 0 } = {}) => {
  const r = (k, len) => Array.from({ length: len }, (_, i) => k * 100000 + off + i);
  return { img: r(1, img), sku: sku ? r(2, n) : [], handle: r(3, n), title: r(4, n), price: price ? Array(n).fill(0) : [] };
};

test("identical catalogues with SKUs score 100", () => {
  assert.equal(scorePair(fp(50), fp(50)).score, 100);
});

test("identical catalogues WITHOUT SKUs (sitemap / Woo) also reach COPY", () => {
  const r = scorePair(fp(50, { sku: false, price: false }), fp(50, { sku: false, price: false }));
  assert.equal(r.score, 100);
  assert.equal(r.verdict, "COPY");
});

test("one side missing SKUs is not read as 0% SKU overlap", () => {
  assert.equal(scorePair(fp(50), fp(50, { sku: false })).score, 100);
});

test("image-only overlap is not inflated when SKUs are missing", () => {
  const a = fp(20, { sku: false }), b = fp(20, { sku: false, off: 50 });
  b.img = a.img.slice(0, 5);  // 5 shared stock photos, nothing else in common
  assert.equal(scorePair(a, b).score, Math.round(34 * 1));  // same as the old formula
});

test("unrelated catalogues score 0", () => {
  assert.equal(scorePair(fp(30), fp(30, { off: 500 })).score, 0);
});
