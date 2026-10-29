/**
 * Deposit Price Display — Storefront Script
 *
 * Appends "+ €0.10 per bottle" next to eligible product prices (product
 * pages and product cards) on any theme. Price elements are found by
 * their content (currency + the product's own price), not by
 * theme-specific classes; an optional selector override lives in the
 * app embed settings.
 *
 * Display only. The deposit itself is charged server-side by the Cart
 * Transform Function (expand mode), so carts and checkout work without
 * this script — on any theme, Buy it now and express checkout included.
 *
 * Eligibility is decided server-side: the app writes deposit units per
 * product ($app:deposit.bottles metafield) — the same data the Cart
 * Transform reads. This script gets it from a Liquid seed (current
 * product) and the /apps/deposit/eligibility app proxy, batched.
 */

(function () {
  "use strict";

  const configScript = document.getElementById("deposit-config");
  let config = {
    enabled: false,
    depositAmount: "0.10",
    currencyCode: "EUR",
    depositVariantId: null,
  };

  if (configScript) {
    try {
      config = Object.assign(config, JSON.parse(configScript.textContent));
    } catch (e) {
      // Fall back to defaults
    }
  }


  // Use the shop's active currency. Shopify.currency is an object
  // ({active, rate}) on most themes — only accept a string code.
  const activeCurrency = window.Shopify?.currency?.active;
  const shopCurrency =
    (typeof activeCurrency === "string" && activeCurrency) ||
    config.currencyCode ||
    "EUR";

  // The deposit is configured in the shop currency; convert it to the
  // presentment currency the customer browses in (the Cart Transform
  // applies the same rate to the deposit component)
  const currencyRate = Number(window.Shopify?.currency?.rate) || 1;
  const depositNumber =
    Math.round((Number(config.depositAmount) || 0) * currencyRate * 100) / 100;

  // Locale-aware currency formatting — renders "€0.10" not "0.10 EUR".
  // Intl throws on an unknown locale/currency; fall back to plain text
  // so a bad value can't abort the script.
  let formatMoney = (n) => `${n.toFixed(2)} ${shopCurrency}`;
  let currencySymbols = [];
  try {
    const fmt = new Intl.NumberFormat(
      document.documentElement.lang || undefined,
      { style: "currency", currency: shopCurrency },
    );
    formatMoney = (n) => fmt.format(n);
    currencySymbols = fmt
      .formatToParts(1)
      .filter((p) => p.type === "currency")
      .map((p) => p.value);
  } catch (e) {}

  /** Label text for a product carrying `bottles` deposit units. */
  function depositTextFor(bottles) {
    if (bottles > 1) {
      return `${formatMoney(Math.round(depositNumber * bottles * 100) / 100)} deposit (${bottles} bottles)`;
    }
    return `${formatMoney(depositNumber)} per bottle`;
  }

  // Theme-agnostic price detection: a price element is one whose text
  // carries a currency marker and whose digits equal one of the
  // product's variant prices. Markers come from the shop's Liquid money
  // formats (the exact strings themes render) plus Intl symbols.
  const themeSettingsScript = document.getElementById("deposit-theme-settings");
  let themeSettings = { moneyFormats: [], priceSelector: "" };
  if (themeSettingsScript) {
    try {
      themeSettings = Object.assign(themeSettings, JSON.parse(themeSettingsScript.textContent));
    } catch (e) {}
  }
  const currencyMarkers = [
    ...new Set(
      [
        ...(themeSettings.moneyFormats || []).map((f) =>
          String(f || "")
            .replace(/<[^>]*>/g, "")
            .replace(/\{\{[^}]*\}\}/g, " "),
        ),
        ...currencySymbols,
        shopCurrency,
      ]
        .flatMap((s) => s.split(/\s+/))
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  const priceSelector = String(themeSettings.priceSelector || "").trim();


  // Cache of product handle -> Promise<product JSON | null>
  const productCache = new Map();
  // Cache of product ID -> Promise<deposit units> (0 = no deposit)
  const bottlesCache = new Map();
  // Server-rendered seed (current product) — positive only
  try {
    const seeds = JSON.parse(
      document.getElementById("deposit-bottles")?.textContent || "{}",
    );
    for (const [id, bottles] of Object.entries(seeds)) {
      if (Number(bottles) > 0) bottlesCache.set(String(id), Promise.resolve(Number(bottles)));
    }
  } catch (e) {}

  /**
   * Fetch a product's storefront JSON (cached per handle). Resolves
   * null for 404. Throws on transient failures — the caller must decide
   * whether a missing eligibility signal is safe to act on.
   */
  function getProduct(handle) {
    if (productCache.has(handle)) return productCache.get(handle);
    const promise = (async () => {
      const res = await fetch(`/products/${handle}.js`);
      if (!res.ok) {
        if (res.status === 404) return null;
        throw new Error(`product fetch ${res.status}`);
      }
      return res.json();
    })();
    promise.catch(() => productCache.delete(handle));
    productCache.set(handle, promise);
    return promise;
  }

  // Batched lookups waiting for the next proxy call: id -> {resolve, reject}
  let bottlesQueue = new Map();
  let bottlesTimer = null;
  const ELIGIBILITY_URL =
    (window.Shopify?.routes?.root || "/") + "apps/deposit/eligibility";

  /**
   * Deposit units per unit for a product ID (0 = no deposit), from the
   * server. Lookups in the same tick share one app proxy request.
   * Rejects on transient failures — the caller must not act on a guess.
   */
  function getBottles(productId) {
    const id = String(productId);
    if (bottlesCache.has(id)) return bottlesCache.get(id);
    const promise = new Promise((resolve, reject) => {
      bottlesQueue.set(id, { resolve, reject });
      if (!bottlesTimer) bottlesTimer = setTimeout(flushBottles, 0);
    });
    promise.catch(() => bottlesCache.delete(id));
    bottlesCache.set(id, promise);
    return promise;
  }

  async function flushBottles() {
    const batch = bottlesQueue;
    bottlesQueue = new Map();
    bottlesTimer = null;
    const ids = [...batch.keys()];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      try {
        const res = await fetch(`${ELIGIBILITY_URL}?ids=${chunk.join(",")}`, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`eligibility ${res.status}`);
        const data = await res.json();
        chunk.forEach((id) => batch.get(id).resolve(Number(data?.products?.[id]) || 0));
      } catch (e) {
        chunk.forEach((id) => batch.get(id).reject(e));
      }
    }
  }

  // ------------------------------------------------------------------
  // Price labels — theme-agnostic
  // ------------------------------------------------------------------
  // Instead of theme-specific classes, a price element is found by its
  // content: the deepest visible element whose text carries a currency
  // marker and whose digits equal one of the product's variant prices.
  // That works the same on Dawn, Horizon and third-party themes, and
  // skips struck-through compare-at prices on its own (different value).
  // Merchants can pin an exact selector in the app embed settings.

  // Never label prices inside these
  const PRICE_SKIP =
    "s, del, strike, button, option, select, script, style, template, " +
    ".deposit-price-text, [class*='compare' i]";

  // Areas that list cart lines or navigation, not product cards
  const CARD_SKIP =
    "header, nav, footer, cart-drawer, cart-drawer-items, cart-items, " +
    'cart-notification, form[action$="/cart"], [id*="CartDrawer"]';

  /** Rendered and larger than a visually-hidden 1px clip. */
  function isVisible(el) {
    return [...el.getClientRects()].some((r) => r.width > 1 && r.height > 1);
  }

  function handleFromHref(href) {
    const m = String(href || "").match(/\/products\/([^/?#]+)/);
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch (e) {
      return m[1];
    }
  }

  /** Variant prices of a product (minor units, presentment currency). */
  function productPrices(product) {
    const prices = new Set();
    if (Number.isFinite(product?.price)) prices.add(product.price);
    for (const v of product?.variants || []) {
      if (Number.isFinite(v.price)) prices.add(v.price);
    }
    return prices;
  }

  /** Does this text read as one of the given prices? */
  function textMatchesPrice(text, prices) {
    if (!text || text.length > 60) return false;
    if (!currencyMarkers.some((m) => text.includes(m))) return false;
    const digits = text.replace(/\D/g, "");
    if (!digits) return false;
    const n = Number(digits);
    for (const p of prices) {
      if (n === p) return true; // "€2,50" / "2.50 EUR" / "€0.05"
      if (p % 100 === 0 && n === p / 100) return true; // "€3" (no decimals)
    }
    return false;
  }

  /** Visible price elements for the given prices inside a container. */
  function findPriceElements(container, prices) {
    if (priceSelector) {
      let els = [];
      try {
        els = [...container.querySelectorAll(priceSelector)];
      } catch (e) {
        // Invalid selector from settings — fall back to detection
      }
      if (els.length > 0) {
        return els.filter((el) => !el.closest(PRICE_SKIP) && isVisible(el));
      }
    }
    const matches = [];
    for (const el of container.querySelectorAll("*")) {
      const text = el.textContent;
      if (!text || text.length > 120) continue; // cheap prefilter
      if (!textMatchesPrice(text.trim(), prices)) continue;
      if (el.closest(PRICE_SKIP)) continue;
      matches.push(el);
    }
    // Deepest only: a wrapper whose text is the same price is skipped
    return matches.filter(
      (el) => !matches.some((o) => o !== el && el.contains(o)) && isVisible(el),
    );
  }

  /** Already labelled (our label sits right after the price). */
  function hasLabel(el) {
    return !!el.nextElementSibling?.classList.contains("deposit-price-text");
  }

  /**
   * Insert the deposit text right after a price element. A sibling (not
   * a child) survives themes and currency apps that rewrite the price
   * element's own text.
   */
  function appendDepositText(priceElement, bottles) {
    if (!priceElement || hasLabel(priceElement)) return;

    const depositSpan = document.createElement("span");
    depositSpan.className = "deposit-price-text";
    depositSpan.dataset.depositLabel = "true";
    depositSpan.style.cssText =
      "font-size: 0.85em; color: #666; margin-left: 4px; display: inline;";
    depositSpan.textContent = "+ " + depositTextFor(bottles);

    priceElement.after(depositSpan);
  }

  /** The section holding the main product form on a product page. */
  function productPageContainer() {
    const form =
      document.querySelector('main form[action*="/cart/add"]') ||
      document.querySelector('form[action*="/cart/add"]');
    return (
      form?.closest(".shopify-section, section") ||
      document.querySelector("main") ||
      document.body
    );
  }

  /**
   * Label the main product price on a product page.
   * Returns the product section (so cards skip it), or null elsewhere.
   */
  async function updateProductPage() {
    const handle = handleFromHref(window.location.pathname);
    if (!handle) return null;
    const container = productPageContainer();

    // The merchant placed the Liquid "Deposit Price" block — don't double up
    if (container.querySelector("[data-deposit-block]")) return container;

    try {
      const product = await getProduct(handle);
      const bottles = product ? await getBottles(product.id) : 0;
      if (!bottles) return container;
      findPriceElements(container, productPrices(product)).forEach((el) =>
        appendDepositText(el, bottles),
      );
    } catch (e) {
      // Transient fetch failure — the next pass retries
    }
    return container;
  }

  /** Widest ancestor of a product link that still holds only that product. */
  function cardFor(link, handle) {
    let card = null;
    let el = link.parentElement;
    for (let i = 0; el && el !== document.body && i < 10; i++) {
      const other = [...el.querySelectorAll('a[href*="/products/"]')].some(
        (a) => handleFromHref(a.getAttribute("href")) !== handle,
      );
      if (other) break;
      card = el;
      el = el.parentElement;
    }
    return card;
  }

  /**
   * Label prices on product cards anywhere on the page (collections,
   * search, recommendations, featured products) — any theme.
   */
  function updateProductCards(excludeContainer) {
    const byHandle = new Map(); // handle -> Set<card>
    document.querySelectorAll('a[href*="/products/"]').forEach((link) => {
      const handle = handleFromHref(link.getAttribute("href"));
      if (!handle || link.closest(CARD_SKIP)) return;
      if (excludeContainer && excludeContainer.contains(link)) return;
      const card = cardFor(link, handle);
      if (!card || card.querySelector(".deposit-price-text")) return;
      if (!byHandle.has(handle)) byHandle.set(handle, new Set());
      byHandle.get(handle).add(card);
    });

    byHandle.forEach(async (cards, handle) => {
      try {
        const product = await getProduct(handle);
        const bottles = product ? await getBottles(product.id) : 0;
        if (!bottles) return;
        const prices = productPrices(product);
        cards.forEach((card) => {
          const [priceEl] = findPriceElements(card, prices);
          if (priceEl) appendDepositText(priceEl, bottles);
        });
      } catch (e) {
        // Transient fetch failure — the next pass retries
      }
    });
  }


  // ------------------------------------------------------------------
  // Leftover deposit lines from the retired "line" mode
  // ------------------------------------------------------------------
  // A standalone deposit line would now be charged on top of the
  // bundled deposit. Liquid lists their keys; remove them once.
  async function removeLeftoverDepositLines() {
    let keys = [];
    try {
      keys = JSON.parse(
        document.getElementById("deposit-leftover-lines")?.textContent || "[]",
      );
    } catch (e) {}
    if (!Array.isArray(keys) || keys.length === 0) return;
    try {
      const res = await fetch("/cart/update.js", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ updates: Object.fromEntries(keys.map((k) => [k, 0])) }),
      });
      // Show the corrected cart (quantities and totals changed)
      if (res.ok && /\/cart\/?$/.test(window.location.pathname)) window.location.reload();
    } catch (e) {}
  }

  // ------------------------------------------------------------------
  // Run
  // ------------------------------------------------------------------

  let isUpdating = false;
  let pendingUpdate = false;

  /** Label product page + cards. Re-entrant calls collapse into one rerun. */
  async function updatePrices() {
    if (isUpdating) {
      pendingUpdate = true;
      return;
    }
    isUpdating = true;
    try {
      updateProductCards(await updateProductPage());
    } finally {
      isUpdating = false;
      if (pendingUpdate) {
        pendingUpdate = false;
        updatePrices();
      }
    }
  }

  function start() {
    // Leftovers are removed even when the deposit is disabled
    removeLeftoverDepositLines();
    if (config.enabled) updatePrices();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  if (!config.enabled) return;

  // Re-run when the theme renders new prices (variant change, infinite
  // scroll, quick view, section re-render). Our own labels are ignored.
  let observerTimeout;
  const observer = new MutationObserver((mutations) => {
    const relevant = mutations.some((m) =>
      Array.from(m.addedNodes).some(
        (n) => !(n.nodeType === 1 && n.dataset?.depositLabel === "true"),
      ),
    );
    if (!relevant) return;
    clearTimeout(observerTimeout);
    observerTimeout = setTimeout(updatePrices, 300);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Theme editor section reloads
  document.addEventListener("shopify:section:load", () => updatePrices());
})();
