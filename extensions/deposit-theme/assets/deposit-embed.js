/**
 * Deposit Price Display — Storefront Script
 *
 * 1. Appends "+ 0.10 EUR per bottle" text on eligible product prices
 *    (product pages, product cards) on any theme — price elements are
 *    found by their content (currency + the product's own price), not
 *    by theme-specific classes. Optional selector override in the
 *    app embed settings.
 *
 * 2. Charges the deposit — depends on the store (config.mode, set by
 *    the app's sync):
 *    - "expand": the Cart Transform Function bundles the deposit into
 *      each product line server-side. This script only shows labels
 *      (and removes leftover standalone deposit lines).
 *    - "line": stores where Shopify refuses Functions from a custom app
 *      (non-Plus plans). This script manages deposit as real cart lines:
 *    - Auto-adds a deposit line per eligible variant, tagged with a
 *      _deposit_for line-item property pointing at that variant
 *    - Keeps each deposit line's quantity equal to its product's quantity
 *    - Removes deposit lines whose product left the cart
 *    - Hides quantity/remove controls on deposit rows
 *    (Different properties keep the lines separate — Shopify does not
 *    merge same-variant items with different properties.)
 *
 * Eligibility is decided server-side: the app writes deposit units per
 * product ($app:deposit.bottles metafield) — the same data the checkout
 * Functions read. This script gets it from Liquid seeds (current product,
 * cart lines) and the /apps/deposit/eligibility app proxy, batched.
 *
 * Line mode is client-side only: Buy it now, express checkout, blocked
 * JS or direct cart API calls skip the deposit (no Function backstop
 * is available on those plans).
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

  // "line" = this script maintains a separate deposit cart line;
  // otherwise the Cart Transform charges it and the cart is left alone
  const LINE_MODE = config.mode === "line";

  if (!config.enabled || !LINE_MODE) {
    // No cart sync → no loading state to wait for
    document.documentElement.classList.add("deposit-ready");
  }
  if (!config.enabled) {
    removeLeftoverDepositLines(config, true);
    return;
  }

  // Use the shop's active currency. Shopify.currency is an object
  // ({active, rate}) on most themes — only accept a string code.
  const activeCurrency = window.Shopify?.currency?.active;
  const shopCurrency =
    (typeof activeCurrency === "string" && activeCurrency) ||
    config.currencyCode ||
    "EUR";

  // The deposit is configured in the shop currency; convert it to the
  // presentment currency the customer browses in (Shopify applies the
  // same rate to the deposit cart line)
  const currencyRate = Number(window.Shopify?.currency?.rate) || 1;
  const depositNumber =
    Math.round((Number(config.depositAmount) || 0) * currencyRate * 100) / 100;

  // Locale-aware currency formatting — renders "€0.10" not "0.10 EUR".
  // Intl throws on an unknown locale/currency; fall back to plain text
  // so a bad value can't abort the script before markReady().
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

  const DEPOSIT_VARIANT_ID = Number(config.depositVariantId) || null;
  // "per_product": each drink has its own "Deposit – <drink>" product,
  // priced for all its bottles; otherwise one shared deposit product
  const PER_PRODUCT = config.style === "per_product";

  // Cache of product handle -> Promise<product JSON | null>
  const productCache = new Map();
  // Cache of product ID -> Promise<deposit units> (0 = no deposit)
  const bottlesCache = new Map();
  // Product ID -> its own deposit variant ID (per_product style), from
  // the Liquid seed and the eligibility proxy
  const depositVariantByProduct = new Map();
  try {
    const seeds = JSON.parse(
      document.getElementById("deposit-variants")?.textContent || "{}",
    );
    for (const [id, variant] of Object.entries(seeds)) {
      if (Number(variant) > 0) depositVariantByProduct.set(String(id), Number(variant));
    }
  } catch (e) {}
  // Server-rendered seeds (current product, cart lines) — positive only.
  // Per-drink style: a seed without the drink's deposit link is skipped,
  // so the proxy supplies both (bottles alone would pick the wrong product)
  try {
    const seeds = JSON.parse(
      document.getElementById("deposit-bottles")?.textContent || "{}",
    );
    for (const [id, bottles] of Object.entries(seeds)) {
      if (!(Number(bottles) > 0)) continue;
      if (PER_PRODUCT && !depositVariantByProduct.has(String(id))) continue;
      bottlesCache.set(String(id), Promise.resolve(Number(bottles)));
    }
  } catch (e) {}
  // Product variant -> deposit variant seen on its linked cart line
  // (fallback when neither seed nor proxy named the drink's deposit)
  const depositVariantSeenFor = new Map();
  // Variant IDs known to be deposit products (row detection, counting)
  const depositVariantIds = new Set(DEPOSIT_VARIANT_ID ? [DEPOSIT_VARIANT_ID] : []);
  depositVariantByProduct.forEach((v) => depositVariantIds.add(v));
  // Handles of deposit products in the cart (row detection fallback)
  const depositHandles = new Set();

  // Guard flag to prevent infinite MutationObserver loop
  let isUpdating = false;
  // Set when a mutation arrives mid-update — re-run once afterwards
  let pendingUpdate = false;
  // Guard flag to prevent overlapping cart syncs
  let isSyncing = false;
  // Set when a trigger arrives mid-sync — re-run afterwards so the
  // final write always uses the freshest cart state
  let pendingSync = false;

  // ---- Cart model (rebuilt on every cart read) ----
  // Fresh cart state and derived lookups let the fetch interceptor
  // rewrite the theme's own cart mutations atomically, so the deposit
  // updates in the SAME request as the customer's change — no lag,
  // no double render.
  let lastCart = null;
  const variantMeta = new Map(); // vid -> {key, handle, qty} for product lines
  const variantBottles = new Map(); // vid -> deposit units per unit (0 = none)
  const productOfVariant = new Map(); // vid -> product ID
  const variantStock = new Map(); // vid -> {quantity, policy}
  const depositKeyFor = new Map(); // product vid -> deposit line key

  /**
   * A deposit line: the shared deposit variant, a known per-drink deposit
   * variant, or any line we linked with _deposit_for.
   */
  function isDepositLine(item) {
    return (
      depositVariantIds.has(item.variant_id) ||
      Boolean(item.properties?._deposit_for)
    );
  }

  /** The deposit variant a product variant's deposit line should use. */
  function depositVariantFor(vid) {
    if (PER_PRODUCT) {
      const own =
        depositVariantByProduct.get(String(productOfVariant.get(vid))) ||
        depositVariantSeenFor.get(vid);
      if (own) return own;
    }
    return DEPOSIT_VARIANT_ID;
  }

  /**
   * Deposit line units per product unit: 1 for a drink's own deposit
   * product (priced for all its bottles), else its bottle count.
   */
  function unitsFor(vid) {
    const bottles = variantBottles.get(vid) || 0;
    if (!bottles) return 0;
    return depositVariantFor(vid) === DEPOSIT_VARIANT_ID ? bottles : 1;
  }

  function indexCart(cart) {
    lastCart = cart;
    variantMeta.clear();
    depositKeyFor.clear();
    for (const item of cart.items || []) {
      if (isDepositLine(item)) {
        const forVid = Number(item.properties?._deposit_for);
        if (forVid) depositKeyFor.set(forVid, item.key);
        if (forVid && item.variant_id !== DEPOSIT_VARIANT_ID) {
          depositVariantSeenFor.set(forVid, item.variant_id);
        }
        depositVariantIds.add(item.variant_id);
        if (item.handle) depositHandles.add(item.handle);
      } else {
        variantMeta.set(item.variant_id, {
          key: item.key,
          handle: item.handle,
          quantity: item.quantity,
        });
      }
    }
  }

  /** Display title of the product a variant id belongs to. */
  function titleForVid(vid) {
    const it = lastCart?.items?.find((i) => i.variant_id === vid);
    return it?.product_title || it?.title || "";
  }

  /**
   * Properties for a deposit line linked to a product variant. A drink's
   * own deposit product names the drink in its title already.
   */
  function depositProps(vid) {
    const props = { _deposit_for: String(vid) };
    const title = titleForVid(vid);
    if (title && depositVariantFor(vid) === DEPOSIT_VARIANT_ID) props["Deposit for"] = title;
    return props;
  }
  // Backoff state — failed writes must not retry in a hot loop
  // (a 429 or network flake would otherwise self-amplify into
  // Cloudflare rate limits)
  let consecutiveFailures = 0;
  let syncCooldownUntil = 0;

  // Native fetch handle — our own cart writes must NOT go through the
  // wrapped window.fetch below, or every write would re-trigger a sync
  // and loop forever.
  const nativeFetch = window.fetch.bind(window);

  /**
   * Fetch a product's storefront JSON (cached per handle). Resolves
   * null for 404. Throws on transient failures — the caller must decide
   * whether a missing eligibility signal is safe to act on.
   */
  function getProduct(handle) {
    if (productCache.has(handle)) return productCache.get(handle);
    const promise = (async () => {
      const res = await nativeFetch(`/products/${handle}.js`);
      if (!res.ok) {
        if (res.status === 404) return null;
        throw new Error(`product fetch ${res.status}`);
      }
      const product = await res.json();
      // Seed stock too — same fetch, needed for over-stock bundling checks
      (product.variants || []).forEach((v) =>
        variantStock.set(Number(v.id), {
          tracked: v.inventory_management === "shopify",
          quantity: v.inventory_quantity,
          policy: v.inventory_policy,
        }),
      );
      return product;
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
        const res = await nativeFetch(`${ELIGIBILITY_URL}?ids=${chunk.join(",")}`, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`eligibility ${res.status}`);
        const data = await res.json();
        chunk.forEach((id) => {
          const variant = Number(data?.depositVariants?.[id]);
          if (variant > 0) {
            depositVariantByProduct.set(id, variant);
            depositVariantIds.add(variant);
          }
          batch.get(id).resolve(Number(data?.products?.[id]) || 0);
        });
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
  // Deposit cart line sync ("line" mode)
  // ------------------------------------------------------------------

  const CART_SECTIONS = "cart-drawer,main-cart-items,cart-icon-bubble";

  async function postCart(url, body) {
    // nativeFetch — bypass the wrapped window.fetch so our own writes
    // don't re-trigger a sync
    const res = await nativeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = new Error(`cart write ${res.status}`);
      // @ts-ignore attach for backoff logic
      err.status = res.status;
      throw err;
    }
    try {
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  /**
   * Re-render cart UI after a programmatic cart change.
   * Dawn listens to PUB_SUB_EVENTS.cartUpdate; other themes use DOM events.
   */
  function refreshCartUi(cartData) {
    try {
      // PUB_SUB_EVENTS is script-scoped in Dawn — not on window — so
      // fall back to the literal event name "cart-update"
      const evt = window.PUB_SUB_EVENTS?.cartUpdate || "cart-update";
      if (typeof window.publish === "function" && cartData?.sections) {
        window.publish(evt, { source: "deposit-sync", cartData });
      }
    } catch (e) {
      // Not a pubsub theme — fall through to DOM events
    }
    document.dispatchEvent(new CustomEvent("cart:updated", { detail: { cart: cartData } }));
    document.dispatchEvent(new CustomEvent("cart:refresh"));
  }

  /**
   * Resolve and cache a variant's deposit units (per product — all
   * variants of a product share them). Throws on transient failures.
   */
  async function ensureBottles(vid, productId) {
    if (productId) productOfVariant.set(vid, productId);
    if (variantBottles.has(vid)) return variantBottles.get(vid);
    const bottles = await getBottles(productId);
    variantBottles.set(vid, bottles);
    return bottles;
  }

  /**
   * Cart quantity of a variant across its lines, optionally substituting
   * one line's quantity (used when intercepting a pending change).
   */
  function productQty(vid, changedKey, newQty) {
    let sum = 0;
    for (const i of lastCart?.items || []) {
      if (i.variant_id !== vid) continue;
      sum += i.key === changedKey ? newQty : i.quantity;
    }
    return sum;
  }

  /** Expected deposit qty for a variant: its quantity × deposit units. */
  function expectedQty(vid, changedKey, newQty) {
    return productQty(vid, changedKey, newQty) * unitsFor(vid);
  }

  /**
   * Seed eligibility for the current product page's variants so an
   * add-to-cart can be bundled immediately without extra fetches.
   */
  async function seedProductEligibility() {
    const handle = handleFromHref(window.location.pathname);
    if (!handle) return;
    try {
      // Shared cached fetch — also seeds variantStock
      const product = await getProduct(handle);
      if (!product) return;
      const bottles = await getBottles(product.id);
      (product.variants || []).forEach((v) => {
        variantBottles.set(Number(v.id), bottles);
        productOfVariant.set(Number(v.id), product.id);
      });
    } catch (e) {}
  }

  /**
   * Remove standalone deposit lines Liquid listed (deposit-leftover-lines)
   * — used when no line is wanted: expand mode, or the deposit disabled.
   */
  async function removeLeftoverDepositLines(cfg, disabled) {
    let keys = [];
    try {
      keys = JSON.parse(
        document.getElementById("deposit-leftover-lines")?.textContent || "[]",
      );
    } catch (e) {}
    if (!Array.isArray(keys) || keys.length === 0) return;
    if (!disabled && cfg.mode === "line") return;
    try {
      const res = await window.fetch("/cart/update.js", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ updates: Object.fromEntries(keys.map((k) => [k, 0])) }),
      });
      // Show the corrected cart (quantities and totals changed)
      if (res.ok && /\/cart\/?$/.test(window.location.pathname)) window.location.reload();
    } catch (e) {}
  }

  /** Lift the CSS loading state (html.deposit-ready). Idempotent. */
  function markReady() {
    document.documentElement.classList.add("deposit-ready");
  }

  /**
   * Can the variant be sold at the requested quantity? Used to decide
   * whether a cart write can be safely bundled — over-stock or unknown
   * stock requests must pass through natively so Shopify returns its
   * inventory error.
   */
  function canSell(vid, qty) {
    const s = variantStock.get(vid);
    if (!s) return false; // unknown → don't bundle, preserve native errors
    if (s.policy === "continue") return true;
    if (!s.tracked) return true; // untracked → unlimited
    if (s.quantity == null) return false; // tracked, qty unknown → don't bundle
    return qty <= s.quantity;
  }

  /**
   * When a cart/add request is intercepted, fire the matching deposit
   * write in parallel so both land together — the deposit appears in
   * the same render instead of a beat later.
   */
  function fireDepositForAdd(init) {
    try {
      const data = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      const adds =
        data?.items ||
        (data?.id ? [{ id: data.id, quantity: data.quantity }] : []);
      for (const a of adds) {
        const vid = Number(a.id);
        const qty = Number(a.quantity || 1);
        const units = unitsFor(vid);
        if (!units || depositVariantIds.has(vid)) continue;
        // Water add will fail server-side on inventory — skip deposit
        const newProductQty = productQty(vid) + qty;
        if (!canSell(vid, newProductQty)) continue;
        const newExpected = newProductQty * units;
        const depKey = depositKeyFor.get(vid);
        const p = depKey
          ? postCart("/cart/change.js", {
              id: depKey,
              quantity: newExpected,
              sections: CART_SECTIONS,
              sections_url: window.location.pathname,
            })
          : postCart("/cart/add.js", {
              items: [
                {
                  id: depositVariantFor(vid),
                  quantity: newExpected,
                  properties: depositProps(vid),
                },
              ],
              sections: CART_SECTIONS,
              sections_url: window.location.pathname,
            });
        p.catch(() => {}); // sync retries
      }
    } catch (e) {}
  }

  /**
   * Rewrite an intercepted /cart/change|update so the deposit
   * adjustment lands in the SAME mutation — atomic, single render.
   * Returns {url, body} or null when bundling isn't possible.
   */
  function buildAtomicWrite(url, init) {
    if (!lastCart || !init || typeof init.body !== "string") return null;
    let data;
    try {
      data = JSON.parse(init.body);
    } catch (e) {
      return null;
    }
    const sections = data.sections;
    const sectionsUrl = data.sections_url;

    if (/\/cart\/change\b/.test(url)) {
      const key =
        data.id || lastCart.items?.[Number(data.line) - 1]?.key;
      const qty = Number(data.quantity);
      if (!key || Number.isNaN(qty)) return null;
      const item = lastCart.items.find((i) => i.key === key);
      if (!item) return null;
      const vid = item.variant_id;

      if (isDepositLine(item)) {
        // Pin deposit edits back to the expected quantity (units not
        // known yet → keep the current quantity; sync settles it)
        const forVid = Number(item.properties?._deposit_for);
        if (!variantBottles.has(forVid)) {
          return {
            url: "/cart/change.js",
            body: JSON.stringify({ ...data, quantity: item.quantity }),
          };
        }
        return {
          url: "/cart/change.js",
          body: JSON.stringify({ ...data, quantity: expectedQty(forVid) }),
        };
      }
      if (!variantBottles.get(vid)) return null;
      // Over-stock → pass through to native /cart/change so Shopify
      // returns its inventory error (update.js would cap silently)
      if (!canSell(vid, qty)) return null;
      const depKey = depositKeyFor.get(vid);
      const newExpected = expectedQty(vid, key, qty);
      if (!depKey) return null; // no deposit line yet → sync adds it
      return {
        url: "/cart/update.js",
        body: JSON.stringify({
          updates: { [key]: qty, [depKey]: newExpected },
          sections,
          sections_url: sectionsUrl,
        }),
        // User-requested qty per line — used to detect silent server
        // caps in the response and synthesize the error
        check: { [key]: qty },
      };
    }

    if (/\/cart\/update\b/.test(url)) {
      if (!data.updates || typeof data.updates !== "object") return null;
      // If any updated line exceeds stock, pass the whole request
      // through so Shopify returns its native inventory error
      for (const [key, qtyStr] of Object.entries(data.updates)) {
        const item = lastCart.items.find((i) => i.key === key);
        if (item && !isDepositLine(item) && !canSell(item.variant_id, Number(qtyStr))) {
          return null;
        }
      }
      const updates = { ...data.updates };
      for (const [key, qtyStr] of Object.entries(data.updates)) {
        const item = lastCart.items.find((i) => i.key === key);
        if (!item) continue;
        const vid = item.variant_id;
        if (isDepositLine(item)) {
          const forVid = Number(item.properties?._deposit_for);
          updates[key] = variantBottles.has(forVid) ? expectedQty(forVid) : item.quantity;
          continue;
        }
        if (!variantBottles.get(vid)) continue;
        const depKey = depositKeyFor.get(vid);
        if (!depKey) continue;
        updates[depKey] = expectedQty(vid, key, Number(qtyStr));
      }
      const check = {};
      for (const [key, qtyStr] of Object.entries(data.updates)) {
        const item = lastCart.items.find((i) => i.key === key);
        if (item && !isDepositLine(item)) {
          check[key] = Number(qtyStr);
        }
      }
      return { url, body: JSON.stringify({ ...data, updates }), check };
    }

    return null;
  }

  /**
   * Ensure deposit lines exist per eligible variant and each quantity
   * matches its product. Deposit lines carry _deposit_for = variant id,
   * so they're attributed to the right product in the order.
   * Idempotent — only writes on mismatch. Backs off on failures.
   * `cartOverride` lets callers pass a fresh cart (from an intercepted
   * response) and skip the /cart.js roundtrip.
   */
  async function syncDepositLine(cartOverride) {
    if (!DEPOSIT_VARIANT_ID) return;
    if (isSyncing) {
      pendingSync = true;
      return;
    }
    if (Date.now() < syncCooldownUntil) return;
    isSyncing = true;

    try {
      let cart = cartOverride;
      if (!cart) {
        const res = await nativeFetch("/cart.js");
        if (!res.ok) throw new Error(`cart read ${res.status}`);
        cart = await res.json();
      }

      // variantId -> expected deposit qty for non-deposit lines
      const expectedByVariant = new Map();
      const depositLines = [];

      indexCart(cart);
      patchCartCount();

      // Resolve every line's deposit units up front — one batched proxy
      // request instead of one per line. Throws → abort without writing.
      await Promise.all(
        (cart.items || [])
          .filter((i) => !isDepositLine(i))
          .map((i) => ensureBottles(i.variant_id, i.product_id)),
      );

      for (const item of cart.items || []) {
        if (isDepositLine(item)) {
          depositLines.push(item);
          continue;
        }
        // Throws on transient fetch failures → abort without writing
        await ensureBottles(item.variant_id, item.product_id);
        const units = unitsFor(item.variant_id);
        if (units > 0) {
          expectedByVariant.set(
            item.variant_id,
            (expectedByVariant.get(item.variant_id) || 0) + item.quantity * units,
          );
        }
      }

      const writes = [];

      // Fix or remove existing deposit lines
      for (const line of depositLines) {
        const forVid = Number(line.properties?._deposit_for) || null;
        // A line on the wrong deposit product (style switched) counts
        // as an orphan: removed here, re-added on the right one below
        const rightProduct = forVid && line.variant_id === depositVariantFor(forVid);
        const expected = rightProduct ? expectedByVariant.get(forVid) || 0 : 0;
        if (expected === 0) {
          // Orphan: product left the cart, a legacy line without the
          // _deposit_for property, or the wrong deposit product → remove
          writes.push(
            postCart("/cart/change.js", {
              id: line.key,
              quantity: 0,
              sections: CART_SECTIONS,
              sections_url: window.location.pathname,
            }),
          );
        } else if (
          line.quantity !== expected ||
          Boolean(line.properties?.["Deposit for"]) !== Boolean(depositProps(forVid)["Deposit for"])
        ) {
          // Wrong qty, or the visible "Deposit for" note missing/extra
          writes.push(
            postCart("/cart/change.js", {
              id: line.key,
              quantity: expected,
              properties: depositProps(forVid),
              sections: CART_SECTIONS,
              sections_url: window.location.pathname,
            }),
          );
        }
      }

      // Add missing deposit lines (one per eligible variant)
      for (const [vid, qty] of expectedByVariant) {
        const exists = depositLines.some(
          (l) => Number(l.properties?._deposit_for) === vid && l.variant_id === depositVariantFor(vid),
        );
        if (!exists) {
          writes.push(
            postCart("/cart/add.js", {
              items: [
                {
                  id: depositVariantFor(vid),
                  quantity: qty,
                  properties: depositProps(vid),
                },
              ],
              sections: CART_SECTIONS,
              sections_url: window.location.pathname,
            }),
          );
        }
      }

      const results = await Promise.allSettled(writes);
      const rejected = results.find((r) => r.status === "rejected");
      if (rejected) throw rejected.reason;

      consecutiveFailures = 0;
      const last = [...results].reverse().find(
        (r) => r.status === "fulfilled" && r.value,
      );
      // Re-index from the post-write cart so row positions and
      // deposit lines match the state the theme is about to render
      if (last?.value?.items) indexCart(last.value);
      if (last) refreshCartUi(last.value);
      lockDepositRows();
    } catch (e) {
      // Any failure (rate limit, network, eligibility fetch) → back off
      // exponentially, capped at 60s. Never write based on partial data.
      consecutiveFailures += 1;
      const delay = Math.min(60000, 2000 * Math.pow(2, consecutiveFailures));
      syncCooldownUntil = Date.now() + delay;
    } finally {
      isSyncing = false;
      markReady();
      if (pendingSync) {
        pendingSync = false;
        syncDepositLine();
      }
    }
  }

  /**
   * Inject the CSS that hides interactive controls on the deposit row.
   */
  function injectLockStyles() {
    if (document.getElementById("deposit-lock-styles")) return;
    const style = document.createElement("style");
    style.id = "deposit-lock-styles";
    // Variant-keyed selectors hide the controls before JS ever runs on
    // the row — no flash even when the theme re-renders the section.
    // Sibling selectors (~) cover browsers without :has() support.
    style.textContent = `
      quantity-input[data-quantity-variant-id="${DEPOSIT_VARIANT_ID}"],
      quantity-input[data-quantity-variant-id="${DEPOSIT_VARIANT_ID}"] ~ cart-remove-button,
      quantity-input[data-quantity-variant-id="${DEPOSIT_VARIANT_ID}"] ~ .quantity-popover__info-button,
      quantity-input[data-quantity-variant-id="${DEPOSIT_VARIANT_ID}"] ~ .cart-items__info,
      .quantity-popover-container:has(quantity-input[data-quantity-variant-id="${DEPOSIT_VARIANT_ID}"]),
      quantity-popover:has(quantity-input[data-quantity-variant-id="${DEPOSIT_VARIANT_ID}"]),
      .quantity-popover-wrapper:has(quantity-input[data-quantity-variant-id="${DEPOSIT_VARIANT_ID}"]),
      tr:has(quantity-input[data-quantity-variant-id="${DEPOSIT_VARIANT_ID}"]) cart-remove-button,
      .deposit-line-locked quantity-input,
      .deposit-line-locked quantity-popover,
      .deposit-line-locked quantity-popover-container,
      .deposit-line-locked .quantity-popover-container,
      .deposit-line-locked cart-remove-button,
      .deposit-line-locked .cart-item__quantity-wrapper,
      .deposit-line-locked .cart-item__remove,
      .deposit-line-locked .quantity { display: none !important; }
    `;
    document.head.appendChild(style);
  }

  /**
   * Lock a single deposit cart row: hide qty input + remove button,
   * show the quantity as static text.
   */
  function lockRow(row) {
    if (!row) return;
    if (row.dataset.depositLocked !== "true") {
      row.dataset.depositLocked = "true";
      row.classList.add("deposit-line-locked");

      const qtyInput = row.querySelector(
        "input[name='updates[]'], input[data-quantity-line-key]",
      );
      const qty = qtyInput?.value || "";

      // The quantity control itself is CSS-hidden — put the static qty
      // text into the cell that wraps the hidden popover (the popover's
      // parent stays visible in both cart-page <td> and drawer markup;
      // note quantity-popover-container is a class, not an element)
      const qtyCell =
        row.querySelector("quantity-popover")?.parentElement ||
        row.querySelector(".cart-item__quantity") ||
        row.querySelector(".quantity-popover-container")?.parentElement ||
        qtyInput?.closest("td");
      if (qtyCell && !qtyCell.querySelector(".deposit-qty-static")) {
        const span = document.createElement("span");
        span.className = "deposit-qty-static";
        span.style.cssText = "font-size: 0.9em; color: #666;";
        span.textContent = qty;
        qtyCell.appendChild(span);
      }
    }
  }

  /**
   * Rewrite the cart-count bubble to exclude deposit quantities.
   * Runs synchronously in the observer (before paint) so the number
   * never visibly flips — same trick as the row locking.
   */
  function patchCartCount() {
    if (!lastCart) return;
    const count = (lastCart.items || []).reduce(
      (s, i) => (isDepositLine(i) ? s : s + i.quantity),
      0,
    );
    document.querySelectorAll(".cart-count-bubble").forEach((b) => {
      const num = b.querySelector("span[aria-hidden]");
      const label = b.querySelector(".visually-hidden");
      // Only write when different — every write is a DOM mutation
      // that re-triggers the observer (infinite loop otherwise)
      if (num && num.textContent.trim() !== String(count)) {
        num.textContent = String(count);
      }
      const labelText = `${count} item${count === 1 ? "" : "s"}`;
      if (label && label.textContent !== labelText) {
        label.textContent = labelText;
      }
      const wantDisplay = count === 0 ? "none" : "";
      if (b.style.display !== wantDisplay) {
        b.style.display = wantDisplay;
      }
    });
  }

  /**
   * Find the deposit row in the rendered cart (page + drawer) and lock it.
   * Dawn quantity inputs carry data-quantity-line-key="{variantId}:{hash}".
   * Fallback: match the product link href to the deposit handle.
   */
  function lockDepositRows() {
    if (!DEPOSIT_VARIANT_ID) return;
    injectLockStyles();

    const rows = new Set();

    document
      .querySelectorAll("[data-quantity-line-key]")
      .forEach((el) => {
        // Line keys are "{variantId}:{hash}"
        const key = el.getAttribute("data-quantity-line-key") || "";
        if (!depositVariantIds.has(Number(key.split(":")[0]))) return;
        const row = el.closest(
          "tr.cart-item, .cart-item, .cart-drawer-item, tr, li",
        );
        if (row) rows.add(row);
      });

    for (const handle of depositHandles) {
      document
        .querySelectorAll(`a[href*="/products/${handle}"]`)
        .forEach((a) => {
          const row = a.closest(
            "tr.cart-item, .cart-item, .cart-drawer-item",
          );
          if (row) rows.add(row);
        });
    }

    rows.forEach(lockRow);
  }

  /**
   * Main update function — runs on all page types.
   * Guarded against infinite loops from MutationObserver.
   * `cartOverride` — fresh cart state from an intercepted response,
   * skips the /cart.js roundtrip for the sync.
   */
  async function updatePrices(cartOverride) {
    if (isUpdating) return;
    isUpdating = true;

    try {
      // Product page label runs alongside the cart sync so its product
      // fetch never delays lifting the cart loading state
      const productPage = updateProductPage();

      // Sync deposit lines + re-lock controls (async) — line mode only
      if (LINE_MODE) await syncDepositLine(cartOverride);

      // Product cards on every page type (collections, search, product
      // recommendations, featured products) — minus the main product
      updateProductCards(await productPage);
    } finally {
      // Release the guard; if mutations arrived while we were working,
      // run once more so no cart change is ever missed
      isUpdating = false;
      if (pendingUpdate) {
        pendingUpdate = false;
        updatePrices();
      }
    }
  }

  // Expand mode: standalone deposit lines (from line mode) would be
  // charged on top of the bundled deposit — remove them once
  if (!LINE_MODE) removeLeftoverDepositLines(config, false);

  // Run on DOM ready. seedProductEligibility warms the variant->eligible
  // cache so the first add-to-cart can be bundled immediately.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      updatePrices();
      seedProductEligibility();
    });
  } else {
    updatePrices();
    seedProductEligibility();
  }

  // Retry once after 1s in case <cart-items> renders async after DOMContentLoaded
  setTimeout(updatePrices, 1000);

  // Failsafe: never leave the loading state up if the first sync can't
  // complete (cooldown, missing config, persistent errors)
  setTimeout(markReady, 4000);

  // Re-run on cart section re-render (AJAX cart updates)
  // Filter out mutations from our own injected elements to prevent loops
  let observerTimeout;
  const observer = new MutationObserver((mutations) => {
    // Lock deposit rows immediately — observer callbacks run after DOM
    // insertion but before paint, so the class lands before the row is
    // ever drawn (kills the quantity-popover flash on section re-render)
    if (LINE_MODE) {
      lockDepositRows();
      patchCartCount();
    }

    for (const mutation of mutations) {
      // Skip mutations inside elements we manage (count bubble, qty
      // text) — our own writes must not schedule another pass
      const t = mutation.target;
      if (
        t.nodeType === 1 &&
        (t.closest?.(".cart-count-bubble") ||
          t.classList?.contains("deposit-qty-static"))
      ) {
        continue;
      }

      // Skip mutations that only involve our own elements
      const addedByUs = Array.from(mutation.addedNodes).every(
        (n) =>
          n.nodeType === 1 &&
          (n.dataset?.depositLine === "true" ||
            n.dataset?.depositLabel === "true" ||
            n.classList?.contains("deposit-qty-static") ||
            n.id === "deposit-lock-styles"),
      );
      if (addedByUs && mutation.addedNodes.length > 0) continue;

      if (mutation.addedNodes.length > 0) {
        if (isUpdating) {
          pendingUpdate = true;
          return;
        }
        clearTimeout(observerTimeout);
        observerTimeout = setTimeout(updatePrices, 300);
        break;
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Re-run on variant change (product page)
  document.addEventListener("change", (e) => {
    if (e.target.matches('input[name="id"], select[name="id"]')) {
      setTimeout(updatePrices, 300);
    }
  });

  // Re-run on Shopify section render events. Wrapped: the Event object
  // must never reach updatePrices as a cart override.
  document.addEventListener("shopify:section:load", () => updatePrices());

  // Everything below keeps the deposit cart line in sync — line mode only
  if (!LINE_MODE) return;

  document.addEventListener("cart:updated", () => updatePrices());
  document.addEventListener("cart:refresh", () => updatePrices());

  // Catch every AJAX cart operation regardless of theme: wrap fetch and
  // re-sync once the request completes. This is the reliable trigger —
  // DOM events and observers vary by theme and can be missed.
  // Our own writes use nativeFetch so they don't re-trigger a sync.
  const cartWriteRe = /\/cart\/(add|change|update|clear)\b/;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input?.url || "";
    if (!cartWriteRe.test(url)) {
      return nativeFetch(input, init);
    }

    // Atomically bundle the deposit adjustment into the theme's own
    // change/update request when possible; for adds, fire the deposit
    // write in parallel. Either way the cart lands consistent — one
    // render, no lag.
    let target = input;
    let targetInit = init;
    let check = null;
    try {
      const rw = buildAtomicWrite(url, init);
      if (rw) {
        target = rw.url;
        targetInit = { ...init, body: rw.body };
        check = rw.check || null;
      } else if (/\/cart\/add\b/.test(url)) {
        fireDepositForAdd(init);
      }
    } catch (e) {}

    return nativeFetch(target, targetInit).then(async (res) => {
      let cart = null;
      try {
        cart = await res.clone().json();
      } catch (e) {}

      // Verify the server actually applied the requested qty — update.js
      // caps over-stock silently, so synthesize the error Dawn shows for
      // native /cart/change requests (uses its own quantityError string)
      if (check && cart && Array.isArray(cart.items)) {
        const cappedKey = Object.keys(check).find((k) => {
          const it = cart.items.find((i) => i.key === k);
          return it && it.quantity < check[k];
        });
        if (cappedKey) {
          const actual = cart.items.find((i) => i.key === cappedKey).quantity;
          const template =
            window.cartStrings?.quantityError ||
            "You can only add [quantity] of this item to your cart.";
          const msg = template.replace("[quantity]", String(actual));
          setTimeout(() => updatePrices(cart), 50);
          return new Response(JSON.stringify({ ...cart, errors: msg }), {
            status: res.status,
            headers: res.headers,
          });
        }
      }

      setTimeout(
        () => updatePrices(cart && Array.isArray(cart.items) ? cart : null),
        50,
      );
      return res;
    });
  };

  // Same for XMLHttpRequest — some themes (and jQuery.ajax) use XHR
  const NativeXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (cartWriteRe.test(String(url))) {
      this.addEventListener("loadend", () => {
        let cart = null;
        try {
          const data = JSON.parse(this.responseText);
          if (data && Array.isArray(data.items)) cart = data;
        } catch (e) {}
        setTimeout(() => updatePrices(cart), 50);
      });
    }
    return NativeXHROpen.apply(this, arguments);
  };

  // Dawn-style pubsub (used by Dawn, Prestige and other themes).
  // PUB_SUB_EVENTS is script-scoped — use the literal "cart-update".
  try {
    if (typeof window.subscribe === "function") {
      const evt = window.PUB_SUB_EVENTS?.cartUpdate || "cart-update";
      window.subscribe(evt, () => setTimeout(updatePrices, 250));
    }
  } catch (e) {}

})();
