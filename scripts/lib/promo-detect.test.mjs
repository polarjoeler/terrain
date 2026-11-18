// node --test scripts/lib/promo-detect.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { detectOffers, htmlToText, findKlaviyoCid, bfLinksFromHtml, bfLinksFromSitemap, collectionSitemaps, parseOffer } from "./promo-detect.mjs";

test("BF banner with up-to %", () => {
  const [o] = detectOffers("Free delivery over R750 · BLACK FRIDAY SALE · Up to 50% off sitewide · Shop now");
  assert.equal(o.kind, "bf");
  assert.equal(o.pct_max, 50);
  assert.equal(o.up_to, true);
  assert.equal(o.sitewide, true);
});

test("welcome popup is not a BF deal", () => {
  const [o] = detectOffers("Sign up to our newsletter and get 10% off your first order");
  assert.equal(o.kind, "welcome");
  assert.equal(o.pct_max, 10);
});

test("bare percentages that aren't offers are ignored", () => {
  assert.deepEqual(detectOffers("100% cotton tee, 95% organic. Made in Cape Town."), []);
});

test("BF mention with no number still counts", () => {
  const [o] = detectOffers("Our Black Friday sale starts 27 November");
  assert.equal(o.kind, "bf");
  assert.equal(o.pct_max, null);
});

test("rand off + code", () => {
  const o = parseOffer("Cyber Monday: R200 off orders over R1000 with code CYBER200");
  assert.equal(o.kind, "bf");
  assert.equal(o.rand_off, 200);
  assert.equal(o.code, "CYBER200");
});

test("htmlToText strips scripts and decodes entities", () => {
  const t = htmlToText('<div>Black&nbsp;Friday &#8211; 30% off</div><script>var x="50% off"</script>');
  assert.match(t, /Black Friday – 30% off/);
  assert.doesNotMatch(t, /50%/);
});

test("klaviyo cid", () => {
  assert.equal(findKlaviyoCid('<script src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=AbC123"></script>'), "AbC123");
});

test("BF links: same-site only", () => {
  const html = '<a href="/collections/black-friday-2026">x</a><a href="https://other.com/collections/black-friday">y</a><a href="/collections/new">z</a>';
  assert.deepEqual(bfLinksFromHtml(html, "https://www.shop.co.za/"), ["https://www.shop.co.za/collections/black-friday-2026"]);
});

test("stale-year and blog BF links are dropped", () => {
  const html = '<a href="/collections/black-friday-2024">a</a><a href="/blogs/news/bfcm-2026-guide">b</a><a href="/collections/black-friday-2026">c</a>';
  assert.deepEqual(bfLinksFromHtml(html, "https://s.co.za/"), ["https://s.co.za/collections/black-friday-2026"]);
});

test("double-encoded entities decode", () => {
  assert.equal(htmlToText("<p>Up to 50% off &amp;bull; Black Friday &times;</p>"), "Up to 50% off · Black Friday ×");
});

test("blog teasers aren't offers", () => {
  assert.deepEqual(detectOffers("Home · ARTICLE · NOV 16, 2026 15 crafting supplies to grab this BFCM 2026! · Shop"), []);
  assert.deepEqual(detectOffers("Blog · 0 Comments · Black November 2026 · November 3, 2026"), []);
});

test("sitemaps", () => {
  const idx = "<sitemapindex><sitemap><loc>https://s.co.za/sitemap_products_1.xml?from=1</loc></sitemap><sitemap><loc>https://s.co.za/sitemap_collections_1.xml?from=1&amp;to=9</loc></sitemap></sitemapindex>";
  assert.deepEqual(collectionSitemaps(idx), ["https://s.co.za/sitemap_collections_1.xml?from=1&to=9"]);
  const xml = "<url><loc>https://s.co.za/collections/bfcm-deals</loc></url><url><loc>https://s.co.za/collections/shoes</loc></url>";
  assert.deepEqual(bfLinksFromSitemap(xml), ["https://s.co.za/collections/bfcm-deals"]);
});
