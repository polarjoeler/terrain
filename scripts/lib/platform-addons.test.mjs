// node --test scripts/lib/platform-addons.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { wixApps, magentoAddons, opencartAddons, odooInfoApps, looksOdoo, platformAddons, ownsHost } from "./platform-addons.mjs";

const wixPage = (...names) => names.map((n, i) => `{"appDefinitionId":"id-${i}","appDefinitionName":${JSON.stringify(n)}}`).join(",");

test("Wix: named apps are kept, platform plumbing and internal slugs are dropped", () => {
  const h = wixPage("ShoutOut (Legacy)", "Data Binding", "Wix CMS", "Checkout & Orders", "Members About",
    "Wix Stores", "Fera Reviews", "Weglot Translate", "ricos-viewer-ooi", "FAQ Widget - dev", "Wix Stores");
  assert.deepEqual(wixApps(h), ["Wix Stores", "Fera Reviews", "Weglot Translate"]);
  assert.deepEqual(wixApps(`{"appDefinitionName":"123 Form Builder \\u0026 Payments"}`), ["123 Form Builder & Payments"]);
  assert.deepEqual(wixApps("<html>no wix here</html>"), []);
});

test("Magento 2: vendor modules and theme from the store's own static paths; core modules dropped", () => {
  const h = `<link href="https://arenaswimming.co.za/static/version1700/frontend/Vaimo/performancebrandsb2c/en_US/Klevu_Search/css/x.css">
    <script src="/static/version1700/frontend/Vaimo/performancebrandsb2c/en_US/Magento_Theme/js/a.js"></script>
    <script src="/static/version1700/frontend/Vaimo/performancebrandsb2c/en_US/PayPal_Braintree/js/b.js"></script>
    <script type="text/x-magento-init">{"*":{"Amasty_Storelocator/js/main":{}}}</script>`;
  // x-magento-init and require() name components by Vendor_Module/js/… too
  const r = magentoAddons(h + `<script>require(["Swissup_Breeze/js/core"])</script>`, "arenaswimming.co.za");
  assert.deepEqual(r.plugins, ["Amasty_Storelocator", "Klevu_Search", "Swissup_Breeze"]);
  assert.equal(r.theme, "Vaimo/performancebrandsb2c");
  assert.equal(magentoAddons(`<link href="/static/frontend/Magento/luma/en_US/css/styles.css">`, "x.co.za").theme, null);
});

test("Magento: another site's assets are not this store's", () => {
  const h = `<img src="https://www.mothercare.co.id/static/version1/frontend/Codilar/mothercare/en_US/Kanmo_CustomerName/x.png">`;
  assert.deepEqual(magentoAddons(h, "cartoyz.co.za"), { plugins: [], theme: null });
  // a ubuy.ae widget carries a Magento 1 skin path; without Magento 1's own scripts it is ignored
  assert.equal(magentoAddons(`url(https://d3ulwu8fab47va.cloudfront.net/skin/frontend/default/ubuycom-v1/a.svg)`, "2ontabak.co.za").theme, null);
  assert.equal(magentoAddons(`<script src="/js/mage/cookies.js"></script><link href="/skin/frontend/ultimo/beautique/css/s.css">`, "beautique.co.za").theme, "ultimo/beautique");
  assert.equal(ownsHost("static.shop.co.za", "shop.co.za"), true);
  assert.equal(ownsHost("d1abc.cloudfront.net", "shop.co.za"), true);
  assert.equal(ownsHost("www.pinnacle.co.za", "pinnsec.co.za"), false);
});

test("OpenCart: extension scripts, routes and theme; stock libraries dropped", () => {
  const h = `<script src="catalog/view/javascript/jquery/jquery-2.1.1.min.js"></script>
    <script src="catalog/view/javascript/bootstrap/js/bootstrap.min.js"></script>
    <script src="catalog/view/javascript/common.js"></script>
    <script src="catalog/view/javascript/xshippingpro.min.js"></script>
    <link href="extension/so_theme/catalog/view/javascript/so_quickview/css/q.css">
    <link href="catalog/view/theme/journal3/stylesheet/s.css">
    <link rel="manifest" href="index.php?route=extension/analytics/progressive_web_application/manifest">
    <img src="index.php?route=extension/captcha/basic/captcha">`;
  const r = opencartAddons(h, "atmotile.co.za");
  assert.deepEqual(r.plugins, ["progressive_web_application", "so_quickview", "so_theme", "xshippingpro"]);
  assert.equal(r.theme, "journal3");
  assert.equal(opencartAddons(`<link href="catalog/view/theme/default/stylesheet/stylesheet.css">`, "x.co.za").theme, null);
});

test("Odoo: /website/info lists installed apps; Website itself is dropped", () => {
  const info = `<h2>Installed Applications</h2>
    <dl class="dl-horizontal"><dt> <a href="https://www.cybrosys.com"> Stock Picking From Invoice </a> </dt><dd><span>x</span></dd></dl>
    <dl class="dl-horizontal"><dt> <a href="https://www.odoo.com/app/sales"> Sales </a> </dt><dd><span>From quotations to invoices</span></dd></dl>
    <dl class="dl-horizontal"><dt> <a href="https://www.odoo.com/app/website"> Website </a> </dt></dl>
    <dl class="dl-horizontal"><dt><a href="https://www.odoo.com/app/ecommerce">eCommerce</a></dt></dl>`;
  assert.deepEqual(odooInfoApps(info), ["Stock Picking From Invoice", "Sales", "eCommerce"]);
  assert.deepEqual(odooInfoApps("<h1>404</h1>"), []);
  assert.deepEqual(odooInfoApps(null), []);
  assert.equal(looksOdoo(`<script src="/web/assets/1/e30f6b7/web.assets_frontend_minimal.min.js">`, null), true);
  assert.equal(looksOdoo("<html></html>", "Odoo"), true);
  assert.equal(looksOdoo("<html></html>", "WooCommerce"), false);
});

test("platformAddons runs every reader regardless of the row's platform label", () => {
  const r = platformAddons(wixPage("Wix Bookings") + `<script src="catalog/view/javascript/live_search/x.js">`, "x.co.za");
  assert.deepEqual(r.plugins, ["Wix Bookings", "live_search"]);
});
