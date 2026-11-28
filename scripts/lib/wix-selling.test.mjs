// node --test scripts/lib/wix-selling.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { classifyWix, sitemapHasProducts, needsSitemap } from "./wix-selling.mjs";

const v = (apps, hasProducts, appListRead = true) => classifyWix({ apps, appListRead, hasProducts }).verdict;

test("the sitemap decides whether an installed Wix Stores has products", () => {
  const idx = (...s) => `<?xml version="1.0"?><sitemapindex>${s.map((x) => `<sitemap><loc>https://x.co.za/${x}</loc></sitemap>`).join("")}</sitemapindex>`;
  assert.equal(sitemapHasProducts(idx("pages-sitemap.xml", "store-products-sitemap.xml")), true);
  assert.equal(sitemapHasProducts(idx("pages-sitemap.xml", "blog-posts-sitemap.xml")), false);
  assert.equal(sitemapHasProducts("<html>404</html>"), null);
  assert.equal(sitemapHasProducts(null), null);
  assert.equal(v(["Wix Stores", "Wix Chat"], true), "products");
  assert.equal(v(["Wix Stores", "Wix Chat"], false), "empty_shop");
  assert.equal(v(["Wix Stores"], null), "unknown");               // no readable sitemap: leave it
  assert.equal(needsSitemap(["Online Store"]), true);
  assert.equal(needsSitemap(["Wix Stores", "Ecwid Shopping Cart"]), false);
});

test("bookings, tickets, plans and pay buttons are services; an empty shop beside them is too", () => {
  assert.equal(v(["Wix Bookings", "Wix Blog"]), "services");
  assert.equal(v(["Wix Events & Tickets"]), "services");
  assert.equal(v(["Wix Pricing Plans", "Wix Online Programs"]), "services");
  assert.equal(v(["Pay Button (Classic)"]), "services");
  assert.equal(v(["123 Form Builder & Payments"]), "services");
  assert.equal(v(["Wix Stores", "Wix Bookings"], false), "services");
  assert.equal(v(["Wix Stores", "Wix Bookings"], true), "products");
});

test("third-party shops and restaurant ordering sell without a Wix Stores catalogue", () => {
  assert.equal(v(["Wix Restaurants Orders 2", "Wix Restaurants Menus"]), "products");
  assert.equal(v(["eCommerce Store by POWR"]), "products");
  assert.equal(v(["Etsy Shop", "Wix Blog"]), "products");
});

test("an app list with nothing that sells is a brochure; no app list is unknown", () => {
  assert.equal(v(["Wix Chat", "Wix Blog", "Instagram Feed", "Wix Donations", "Reserve with Google conversion"]), "brochure");
  assert.equal(v([]), "brochure");
  assert.equal(v([], undefined, false), "unknown");
  assert.equal(v(["Wix Bookings"], undefined, false), "unknown");
});
