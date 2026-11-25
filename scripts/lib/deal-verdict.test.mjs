import test from "node:test";
import assert from "node:assert/strict";
import { dealVerdict } from "./deal-verdict.mjs";
test("same price as before despite a was-price", () => assert.equal(dealVerdict({ price: 750, regular: 1350, old: 750 }).v, "same"));
test("inflated was-price, smaller real saving", () => { const r = dealVerdict({ price: 3899, regular: 14999, old: 4099 }); assert.equal(r.v, "inflated"); assert.equal(r.realPct, 5); assert.equal(r.claimedPct, 74); });
test("real saving", () => assert.equal(dealVerdict({ price: 1000, regular: 3900, old: 3900 }).v, "real"));
test("different pack size is ignored", () => assert.equal(dealVerdict({ price: 2499, regular: 3000, old: 499 }), null));
test("no old price", () => assert.equal(dealVerdict({ price: 10 }), null));
