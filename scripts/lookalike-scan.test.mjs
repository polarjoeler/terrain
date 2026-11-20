// node --test scripts/lookalike-scan.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { buildMatcher, assess, BAIT, brandBounded } from "./lookalike-scan.mjs";

const brands = new Map([
  ["ripcurl", { domain: "ripcurl.co.za" }],
  ["yuppiechef", { domain: "yuppiechef.com" }],
  ["bikerswarehouse", { domain: "bikerswarehouse.co.za" }],
]);
const match = buildMatcher(brands);
const now = Date.parse("2026-11-19T12:00:00Z");
const day = (n) => new Date(now - n * 864e5).toISOString();

test("wraps the brand label", () => {
  assert.deepEqual(match("sale-ripcurl.shop"), [{ brand: "ripcurl", how: "wraps" }]);
});
test("same name on another TLD", () => {
  assert.deepEqual(match("ripcurl.store"), [{ brand: "ripcurl", how: "same-name" }]);
});
test("the brand's own subdomain is not a suspect", () => {
  assert.deepEqual(match("shop.ripcurl.co.za"), []);
});
test("one edit away is a typo", () => {
  assert.deepEqual(match("bakerswarehouse.shop"), [{ brand: "bikerswarehouse", how: "typo" }]);
});
test("bait word + throwaway TLD + new → tier A", () => {
  const a = assess({ brand: "yuppiechef", how: "wraps" }, { domain: "yuppiechef-official.store", seen: day(3) }, {}, now);
  assert.equal(a.tier, "A");
  assert.ok(a.signals.some((s) => s.includes("official")));
});
test("an old plain wrap is tier B", () => {
  assert.equal(assess({ brand: "ripcurl", how: "wraps" }, { domain: "ripcurlfans.co.za", seen: day(400) }, {}, now).tier, "B");
});
test("typos are never stored", () => {
  assert.equal(assess({ brand: "bikerswarehouse", how: "typo" }, { domain: "bakerswarehouse.shop", seen: day(5) }, {}, now).tier, null);
});
test("wholesale is not the bait word sale", () => {
  assert.equal(BAIT.test("julzshoes wholesale".replace(/\s/g, "")), false);
  assert.equal(BAIT.test("ripcurlsale"), true);
});

test("a brand buried mid-word is not bounded", () => {
  for (const [d, b] of [["pierretalamonds.shop", "retala"], ["gadmax.store", "admax"], ["josephdavidson.shop", "hdavidson"],
    ["dakotastore.shop", "dakotas"], ["crocssandals.shop", "crocssa"], ["mannsepicdeals.store", "epicdeals"]])
    assert.equal(brandBounded(d, b), false, d);
});
test("a brand at the start, after a hyphen or after lead words is bounded", () => {
  for (const [d, b] of [["sale-ripcurl.shop", "ripcurl"], ["salesripcurl.shop", "ripcurl"], ["officialyuppiechef.store", "yuppiechef"],
    ["thetackshack.shop", "tackshack"], ["foxracinggrove.shop", "foxracing"], ["carrolboyesofficial.co.za", "carrolboyes"], ["www.ripcurl-za.shop", "ripcurl"]])
    assert.equal(brandBounded(d, b), true, d);
});
test("a buried brand with bait words is still only tier B", () => {
  const a = assess({ brand: "admax", how: "wraps" }, { domain: "gadmaxsale.store", seen: day(3) }, {}, now);
  assert.equal(a.tier, "B");
  assert.ok(a.signals.includes("brand name buried inside another word"));
});
