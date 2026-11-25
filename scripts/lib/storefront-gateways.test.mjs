// node --test scripts/lib/storefront-gateways.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { detectGateways, mergeFindings, pageState, platformHomeRedirect, firstProductUrl, extraPathFor, impliedGateways,
  ecwidStoreId, ecwidPayments, ecwidOwns } from "./storefront-gateways.mjs";

const names = (html, own = "shop.co.za") => detectGateways(html, own).map((f) => f.name);

test("a PSP's own host is evidence, wherever the URL sits", () => {
  assert.deepEqual(names(`<script src="https://js.yoco.com/sdk/v1/yoco-sdk-web.js"></script>`), ["Yoco"]);
  assert.deepEqual(names(`<script>var u = "https://www.payfast.co.za/eng/process";</script>`), ["PayFast"]);
  assert.deepEqual(names(`<iframe src="https://eu-prod.oppwa.com/v1/paymentWidgets.js">`), ["Peach Payments"]);
  assert.deepEqual(names(`<a href="https://pay.ozow.com/">`), ["Ozow"]);
  assert.deepEqual(names(`<img src="https://secure.i-pay.co.za/logo.png">`), ["Ozow"]);
});

test("badge images name the gateway by file name or alt text", () => {
  assert.deepEqual(names(`<img src="/assets/yoco_white-aa4ad5b7.png"><img src="/img/payflex-logo.svg">`), ["Yoco", "Payflex"]);
  assert.deepEqual(names(`<img src="/x.png" alt="Peach Payments">`), ["Peach Payments"]);
  assert.deepEqual(names(`<img srcset="/a/paygate5.png 1x, /a/paygate5@2x.png 2x" src="/a/p.png">`), ["PayGate"]);
});

test("icon-font badges carry the name in title / class", () => {
  assert.deepEqual(names(`<a data-placement="top" title="Paypal" href="#"><span class="icon"></span></a>`), ["PayPal"]);
  assert.deepEqual(names(`<div class="paytile paytile--payjustnow"></div>`), ["PayJustNow"]);
  assert.deepEqual(names(`<svg viewBox="0 0 10 10"><title>SnapScan</title></svg>`), ["SnapScan"]);
});

test("a long srcset doesn't hide the alt text on the same tag", () => {
  const srcset = Array.from({ length: 40 }, (_, i) => `/cdn/img-${i}-abcdefabcdef.jpg ${i * 100}w`).join(", ");
  assert.deepEqual(names(`<img srcset="${srcset}" alt="Mobicred">`), ["Mobicred"]);
});

test("plain text and CSS never count", () => {
  // the noise that sank the old regexes: eft/float in CSS, stripe in product names, PayFast in copy
  const noise = `<style>.left{float:left}.eft{margin-left:2px}</style>
    <p>We accept PayFast, Yoco and Ozow at checkout.</p>
    <a href="/products/red-stripe-dress">Red stripe dress</a>
    <img src="/media/peach-colour-scarf.jpg" alt="Peach scarf">`;
  assert.deepEqual(names(noise), []);
});

test("platform payment modules map to gateways, generic modules to nothing", () => {
  const ps = `<link href="/modules/ps_wirepayment/views/css/x.css"><script src="/modules/payfast/views/js/p.js"></script>
    <script src="/modules/ps_shoppingcart/x.js"></script><script src="/modules/ps_checkout/views/js/front.js"></script>`;
  assert.deepEqual(names(ps), ["PayFast", "PayPal", "Bank Transfer"]);
  const oc = `<script src="catalog/view/javascript/extension/payment/yoco.js"></script>
    <link href="extension/peach/catalog/view/stylesheet/peach.css">`;
  assert.deepEqual(names(oc), ["Yoco", "Peach Payments"]);
  assert.deepEqual(names(`<script src="/wp-content/plugins/woocommerce-payfast-gateway/assets/x.js">`), ["PayFast"]);
  assert.deepEqual(names(`<script src="/modules/ps_cashondelivery/x.js"></script><script src="/modules/blockslider/x.js">`), ["Cash on Delivery"]);
});

test("the store's own host isn't evidence about itself; a Netcash-hosted shop implies Netcash", () => {
  assert.deepEqual(names(`<script src="https://store1.shop.netcash.co.za/app.js">`, "store1.shop.netcash.co.za"), []);
  assert.deepEqual(impliedGateways("store87085797.shop.netcash.co.za").map((f) => f.name), ["Netcash"]);
  assert.deepEqual(impliedGateways("shop.co.za"), []);
});

test("mergeFindings keeps one entry per gateway, strongest evidence first", () => {
  const m = mergeFindings(
    [{ name: "Yoco", via: "badge", ev: "yoco.png" }],
    [{ name: "Yoco", via: "host", ev: "js.yoco.com" }, { name: "PayFast", via: "module", ev: "payfast" }],
  );
  assert.deepEqual(m.map((f) => [f.name, f.via]), [["PayFast", "module"], ["Yoco", "host"]]);
});

test("page states: suspended / parked are gone, login walls are portals", () => {
  assert.equal(pageState({ status: 200, url: "https://alexalily.shopstar.co.za/suspended", text: "<title>Coming soon</title>" }), "gone");
  assert.equal(pageState({ status: 200, url: "https://x.co.za/", text: "<h1>This account has been suspended</h1>" }), "gone");
  assert.equal(pageState({ status: 200, url: "https://x.co.za/", text: "This domain may be for sale" }), "gone");
  assert.equal(pageState({ status: 200, url: "https://kovco.co.za/web/login?redirect=/shop", text: "" }), "portal");
  assert.equal(pageState({ status: 403, url: "https://x.co.za/", text: "" }), "blocked");
  assert.equal(pageState({ status: 200, url: "https://x.co.za/", text: "<title>Just a moment...</title>" }), "blocked");
  assert.equal(pageState({ status: 200, url: "https://x.co.za/", text: "<title>Coming Soon | X</title>" }), "holding");
  assert.equal(pageState({ status: 401, url: "https://x.co.za/", text: "" }), "holding");
  assert.equal(pageState({ status: 200, url: "https://x.co.za/", text: "<title>X Shop</title>" }), "ok");
});

test("a redirect to the platform's own site is a closed store", () => {
  assert.equal(platformHomeRedirect("heartworks.shopstar.co.za", "https://www.shopstar.co.za/"), true);
  assert.equal(platformHomeRedirect("x.co.za", "https://www.squarespace.com/"), true);
  assert.equal(platformHomeRedirect("heartworks.shopstar.co.za", "https://heartworks.shopstar.co.za/cart"), false);
  assert.equal(platformHomeRedirect("x.co.za", "https://www.x.co.za/"), false);
});

test("firstProductUrl: same site, real products, not Ecwid's utility pages", () => {
  const base = "https://www.shop.co.za/";
  assert.equal(firstProductUrl(`<a href="/products/cart">c</a><a href="/products/account">a</a><a href="/products/rooibos-balm">p</a>`, base),
    "https://www.shop.co.za/products/rooibos-balm");
  assert.equal(firstProductUrl(`<a href="https://other.com/products/x">x</a>`, base), null);
  assert.equal(firstProductUrl(`<a href="index.php?route=product/product&amp;product_id=42">x</a>`, base),
    "https://www.shop.co.za/index.php?route=product/product&product_id=42");
  assert.equal(firstProductUrl(`<a href="/12-blue-mug.html">x</a>`, base), "https://www.shop.co.za/12-blue-mug.html");
});

test("extra path per platform", () => {
  assert.equal(extraPathFor("OpenCart"), "/index.php?route=checkout/cart");
  assert.equal(extraPathFor("Odoo"), "/shop");
  assert.equal(extraPathFor("custom"), "/cart");
});

const ecwid = (methods, storeUrl = "https://kartstore.co.za/", type = "opened") =>
  ({ storeProfile: { type, value: { jsApiOnly: { storeUrl, paymentMethods: methods } } } });

test("Ecwid store id: loader script, escaped siteId, ownerid, image CDN, Netcash shop host", () => {
  assert.equal(ecwidStoreId(`<script src="https://app.ecwid.com/script.js?77668011&data_platform=code">`), "77668011");
  assert.equal(ecwidStoreId(`ecwid {\\"siteId\\":78879008,\\"serviceUrl\\"`), "78879008");
  assert.equal(ecwidStoreId(`ecwid <a href="https://my.ecwid.com/edit-starter-site?ownerid=131201288&lang=en">`), "131201288");
  assert.equal(ecwidStoreId(`ecwid <img src="https://d2j6dbq0eux0bg.cloudfront.net/images/63607701/4471.jpg">`), "63607701");
  assert.equal(ecwidStoreId(``, "store87085797.shop.netcash.co.za"), "87085797");
  assert.equal(ecwidStoreId(`<img src="/images/63607701/4471.jpg">`), null);       // no Ecwid on the page
});

test("Ecwid payment methods map to canonical gateways, offline methods by their name", () => {
  const e = ecwidPayments(ecwid([
    { name: "Pay with Card or Bank Account", processor: "customPaymentApp", appNamespace: "paystack" },
    { name: "Pay by EFT", processor: "offline" },
    { name: "Credit or debit card", processor: "payFast" },
    { name: "PayGate by Payfast", processor: "customPaymentApp", appClientId: "paygate-appinlet" },
    { name: "Cash on collection", processor: "offline" },
    { name: "SnapScan on collection", processor: "offline" },
    { name: "Card payment via Walletdoc", processor: "customPaymentApp", appClientId: "walletdoc" },
    { name: "PayPal", processor: "paypalStandard" },
  ]));
  assert.equal(e.ok, true);
  assert.equal(e.closed, false);
  assert.deepEqual(e.gateways, ["PayFast", "PayGate", "SnapScan", "WalletDoc", "PayPal", "Paystack", "Bank Transfer", "Cash on Delivery"]);
});

test("Ecwid: a closed store, an empty method list, and a non-Ecwid payload", () => {
  assert.deepEqual(ecwidPayments({ storeProfile: { type: "general-closed" } }).closed, true);
  const none = ecwidPayments(ecwid([]));
  assert.equal(none.ok, true); assert.deepEqual(none.methods, []); assert.deepEqual(none.gateways, []);
  assert.equal(ecwidPayments({ error: "x" }).ok, false);
  assert.equal(ecwidPayments(null).ok, false);
});

test("Ecwid store id must belong to this domain", () => {
  assert.equal(ecwidOwns("kartstore.co.za", "kartstore.co.za"), true);
  assert.equal(ecwidOwns("www.kartstore.co.za", "kartstore.co.za"), true);
  assert.equal(ecwidOwns("shop.kartstore.co.za", "kartstore.co.za"), true);
  assert.equal(ecwidOwns("westendpetfarm.company.site", "westendpetfarm.co.za"), true);   // Instant Site host
  assert.equal(ecwidOwns("someoneelse.co.za", "kartstore.co.za"), false);
});
