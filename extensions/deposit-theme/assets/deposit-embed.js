/**
 * Deposit Price Display — Storefront Script
 *
 * 1. Appends "+ 0.10 EUR per bottle" text on eligible product prices
 *    (product pages, product cards).
 *
 * 2. Manages deposit as real cart lines ("line" mode):
 *    - Auto-adds a deposit line per eligible variant, tagged with a
 *      _deposit_for line-item property pointing at that variant
 *    - Keeps each deposit line's quantity equal to its product's quantity
 *    - Removes deposit lines whose product left the cart
 *    - Hides quantity/remove controls on deposit rows
 *    (Different properties keep the lines separate — Shopify does not
 *    merge same-variant items with different properties.)
 *
 * Eligibility mirrors the server: product tags via /products/{handle}.js,
 * collection membership via /collections/{handle}/products.json.
 */

(function () {
  "use strict";

  const configScript = document.getElementById("deposit-config");
  let config = {
    enabled: false,
    depositAmount: "0.10",
    currencyCode: "EUR",
    depositVariantId: null,
    includeTags: [],
    excludeTags: [],
    includeCollections: [],
    excludeCollections: [],
  };

  if (configScript) {
    try {
      config = Object.assign(config, JSON.parse(configScript.textContent));
    } catch (e) {
      // Fall back to defaults
    }
  }

  if (!config.enabled) return;

  // Use the shop's active currency
  const shopCurrency =
    window.Shopify?.currency?.active ||
    window.Shopify?.currency ||
    config.currencyCode ||
    "EUR";

  const depositText = `${config.depositAmount} ${shopCurrency} per bottle`;

  const DEPOSIT_VARIANT_ID = Number(config.depositVariantId) || null;

  const includeTags = (config.includeTags || []).map((t) => t.toLowerCase());
  const excludeTags = (config.excludeTags || []).map((t) => t.toLowerCase());
  const includeCollections = config.includeCollections || [];
  const excludeCollections = config.excludeCollections || [];

  // Cache of product handle -> tags
  const tagCache = new Map();
  // Cache of collection handle -> Promise<Set<productHandle>>
  const collectionCache = new Map();
  // Handle of the deposit product (read from cart, for row detection)
  let depositHandle = null;

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
  const variantEligible = new Map(); // vid -> bool
  const variantStock = new Map(); // vid -> {quantity, policy}
  const depositKeyFor = new Map(); // product vid -> deposit line key

  function indexCart(cart) {
    lastCart = cart;
    variantMeta.clear();
    depositKeyFor.clear();
    for (const item of cart.items || []) {
      if (item.variant_id === DEPOSIT_VARIANT_ID) {
        const forVid = Number(item.properties?._deposit_for);
        if (forVid) depositKeyFor.set(forVid, item.key);
        depositHandle = item.handle || depositHandle;
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

  /** Properties for a deposit line linked to a product variant. */
  function depositProps(vid) {
    const props = { _deposit_for: String(vid) };
    const title = titleForVid(vid);
    if (title) props["Deposit for"] = title;
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
   * Format a number in European style (e.g., 0.10 -> "0,10")
   */
  function formatPrice(amount) {
    return amount.replace(".", ",");
  }

  /**
   * Check if a product is eligible for deposit based on its tags.
   */
  function isEligibleTags(tags) {
    if (!Array.isArray(tags)) return false;
    const lower = tags.map((t) => t.toLowerCase());
    const included = includeTags.some((t) => lower.includes(t));
    const excluded = excludeTags.some((t) => lower.includes(t));
    return { included, excluded };
  }

  /**
   * Fetch product tags for a handle (cached).
   * Throws on transient failures — the caller must decide whether a
   * missing eligibility signal is safe to act on.
   */
  async function getProductTags(handle) {
    if (tagCache.has(handle)) return tagCache.get(handle);
    const res = await nativeFetch(`/products/${handle}.js`);
    if (!res.ok) {
      if (res.status === 404) {
        tagCache.set(handle, []);
        return [];
      }
      throw new Error(`product fetch ${res.status}`);
    }
    const product = await res.json();
    const tags = product.tags || [];
    tagCache.set(handle, tags);
    // Seed stock too — same fetch, needed for over-stock bundling checks
    (product.variants || []).forEach((v) =>
      variantStock.set(Number(v.id), {
        quantity: v.inventory_quantity,
        policy: v.inventory_policy,
      }),
    );
    return tags;
  }

  /**
   * Fetch the set of product handles in a collection (cached).
   * Throws on transient failures — partial data would produce a wrong
   * eligibility answer, so we abort instead of guessing.
   */
  function getCollectionProducts(handle) {
    if (collectionCache.has(handle)) return collectionCache.get(handle);
    const promise = (async () => {
      const handles = new Set();
      for (let page = 1; page <= 10; page++) {
        const res = await nativeFetch(
          `/collections/${handle}/products.json?limit=250&page=${page}`,
        );
        if (!res.ok) throw new Error(`collection fetch ${res.status}`);
        const data = await res.json();
        const products = data.products || [];
        products.forEach((p) => handles.add(p.handle));
        if (products.length < 250) break;
      }
      return handles;
    })();
    promise.catch(() => collectionCache.delete(handle));
    collectionCache.set(handle, promise);
    return promise;
  }

  async function inCollection(productHandle, collectionHandles) {
    for (const h of collectionHandles) {
      const set = await getCollectionProducts(h);
      if (set.has(productHandle)) return true;
    }
    return false;
  }

  /**
   * Full eligibility check mirroring the Function:
   *   included = tag match OR collection match
   *   excluded = tag match OR collection match
   *   eligible = included && !excluded
   */
  async function isEligibleItem(item) {
    const handle = item.handle;
    if (!handle) return false;

    const { included: tagIn, excluded: tagOut } = isEligibleTags(
      await getProductTags(handle),
    );

    const included =
      tagIn || (await inCollection(handle, includeCollections));
    if (!included) return false;

    const excluded =
      tagOut || (await inCollection(handle, excludeCollections));
    return !excluded;
  }

  /**
   * Append deposit text after a price element (product page & cards).
   */
  function appendDepositText(priceElement) {
    if (!priceElement || priceElement.dataset.depositAdded) return;

    const depositSpan = document.createElement("span");
    depositSpan.className = "deposit-price-text";
    depositSpan.style.cssText =
      "font-size: 0.85em; color: #666; margin-left: 4px; display: inline;";
    depositSpan.textContent = " + " + depositText;

    priceElement.appendChild(depositSpan);
    priceElement.dataset.depositAdded = "true";
  }

  /**
   * Find the visible price element(s) within a price container.
   * When a product is on sale, Dawn hides .price__regular and shows .price__sale.
   * We must only annotate the visible price element.
   */
  function findVisiblePriceElements(container) {
    // Check if this price container is on sale
    const priceWrapper = container.closest(".price");
    if (priceWrapper && priceWrapper.classList.contains("price--on-sale")) {
      // On sale: only target the sale price element (the last one, not the strikethrough)
      return container.querySelectorAll(".price__sale .price-item--sale");
    }
    // Not on sale: target the regular price element
    return container.querySelectorAll(".price__regular .price-item--regular");
  }

  /**
   * Update prices on a product page.
   */
  function updateProductPage() {
    const tagsScript = document.getElementById("deposit-product-tags");
    if (!tagsScript) return;

    let productTags;
    try {
      productTags = JSON.parse(tagsScript.textContent);
    } catch (e) {
      return;
    }

    // Seed the tag cache so the first cart sync skips the
    // /products/{handle}.js fetch for this product
    const handleMatch = window.location.pathname.match(/\/products\/([^/?#]+)/);
    if (handleMatch) tagCache.set(handleMatch[1], productTags);

    const { included, excluded } = isEligibleTags(productTags);
    if (!included || excluded) return;

    // Find all price containers on the page and annotate visible price elements
    document
      .querySelectorAll(".price, .product__price, .product-single__price")
      .forEach((priceContainer) => {
        findVisiblePriceElements(priceContainer).forEach(appendDepositText);
      });
  }

  /**
   * Update prices on product cards (collection/search pages).
   */
  function updateProductCards() {
    const cardLinks = document.querySelectorAll('a[href*="/products/"]');
    const cardsToUpdate = [];

    cardLinks.forEach((link) => {
      const href = link.getAttribute("href");
      const match = href.match(/\/products\/([^/?#]+)/);
      if (!match) return;
      const handle = match[1];

      const card = link.closest(
        ".card, .product-card, .grid__item, .collection-list__item, li",
      );
      if (!card) return;

      // Find the price container within this card
      const priceContainer = card.querySelector(".price");
      if (!priceContainer) return;

      // Find the visible price element (sale or regular, not both)
      const priceEls = findVisiblePriceElements(priceContainer);
      const priceEl = priceEls.length > 0 ? priceEls[0] : null;
      if (!priceEl || priceEl.dataset.depositAdded) return;

      cardsToUpdate.push({ priceEl, handle });
    });

    const handles = [...new Set(cardsToUpdate.map((c) => c.handle))];

    handles.forEach(async (handle) => {
      let tags;
      try {
        tags = await getProductTags(handle);
      } catch (e) {
        return;
      }
      const { included, excluded } = isEligibleTags(tags);
      if (!included || excluded) return;
      cardsToUpdate
        .filter((c) => c.handle === handle)
        .forEach((c) => appendDepositText(c.priceEl));
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
   * Resolve and cache a variant's eligibility (per product — all
   * variants of a product share eligibility).
   */
  async function ensureEligible(vid, handle) {
    if (variantEligible.has(vid)) return variantEligible.get(vid);
    const eligible = await isEligibleItem({ handle, variant_id: vid });
    variantEligible.set(vid, eligible);
    return eligible;
  }

  /**
   * Expected deposit qty for a variant, optionally substituting one
   * line's quantity (used when intercepting a pending change).
   */
  function expectedQty(vid, changedKey, newQty) {
    let sum = 0;
    for (const i of lastCart?.items || []) {
      if (i.variant_id !== vid) continue;
      sum += i.key === changedKey ? newQty : i.quantity;
    }
    return sum;
  }

  /**
   * Seed eligibility for the current product page's variants so an
   * add-to-cart can be bundled immediately without extra fetches.
   */
  async function seedProductEligibility() {
    const m = window.location.pathname.match(/\/products\/([^/?#]+)/);
    if (!m) return;
    try {
      const res = await nativeFetch(`/products/${m[1]}.js`);
      if (!res.ok) return;
      const product = await res.json();
      const handle = m[1];
      tagCache.set(handle, product.tags || []);
      const eligible = await isEligibleItem({ handle });
      (product.variants || []).forEach((v) => {
        variantEligible.set(Number(v.id), eligible);
        variantStock.set(Number(v.id), {
          quantity: v.inventory_quantity,
          policy: v.inventory_policy,
        });
      });
    } catch (e) {}
  }

  /**
   * Can the variant be sold at the requested quantity? Used to decide
   * whether a cart write can be safely bundled — over-stock requests
   * must pass through natively so Shopify returns its inventory error.
   */
  function canSell(vid, qty) {
    const s = variantStock.get(vid);
    if (!s || s.quantity == null) return true; // untracked/unknown
    if (s.policy === "continue") return true;
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
        if (!variantEligible.get(vid) || vid === DEPOSIT_VARIANT_ID) continue;
        // Water add will fail server-side on inventory — skip deposit
        if (!canSell(vid, expectedQty(vid) + qty)) continue;
        const newExpected = expectedQty(vid) + qty;
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
                  id: DEPOSIT_VARIANT_ID,
                  quantity: newExpected,
                  properties: { _deposit_for: String(vid) },
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

      if (vid === DEPOSIT_VARIANT_ID) {
        // Pin deposit edits back to the expected quantity
        const forVid = Number(item.properties?._deposit_for);
        return {
          url: "/cart/change.js",
          body: JSON.stringify({ ...data, quantity: expectedQty(forVid) }),
        };
      }
      if (!variantEligible.get(vid)) return null;
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
      };
    }

    if (/\/cart\/update\b/.test(url)) {
      if (!data.updates || typeof data.updates !== "object") return null;
      // If any updated line exceeds stock, pass the whole request
      // through so Shopify returns its native inventory error
      for (const [key, qtyStr] of Object.entries(data.updates)) {
        const item = lastCart.items.find((i) => i.key === key);
        if (item && item.variant_id !== DEPOSIT_VARIANT_ID && !canSell(item.variant_id, Number(qtyStr))) {
          return null;
        }
      }
      const updates = { ...data.updates };
      for (const [key, qtyStr] of Object.entries(data.updates)) {
        const item = lastCart.items.find((i) => i.key === key);
        if (!item) continue;
        const vid = item.variant_id;
        if (vid === DEPOSIT_VARIANT_ID) {
          const forVid = Number(item.properties?._deposit_for);
          updates[key] = expectedQty(forVid);
          continue;
        }
        if (!variantEligible.get(vid)) continue;
        const depKey = depositKeyFor.get(vid);
        if (!depKey) continue;
        updates[depKey] = expectedQty(vid, key, Number(qtyStr));
      }
      return { url, body: JSON.stringify({ ...data, updates }) };
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

      for (const item of cart.items || []) {
        if (item.variant_id === DEPOSIT_VARIANT_ID) {
          depositLines.push(item);
          continue;
        }
        // Throws on transient fetch failures → abort without writing
        if (await ensureEligible(item.variant_id, item.handle)) {
          expectedByVariant.set(
            item.variant_id,
            (expectedByVariant.get(item.variant_id) || 0) + item.quantity,
          );
        }
      }

      const writes = [];

      // Fix or remove existing deposit lines
      for (const line of depositLines) {
        const forVid = Number(line.properties?._deposit_for) || null;
        const expected = forVid ? expectedByVariant.get(forVid) || 0 : 0;
        if (expected === 0) {
          // Orphan: product left the cart, or a legacy line without
          // the _deposit_for property → remove and re-add properly
          writes.push(
            postCart("/cart/change.js", {
              id: line.key,
              quantity: 0,
              sections: CART_SECTIONS,
              sections_url: window.location.pathname,
            }),
          );
        } else if (line.quantity !== expected || !line.properties?.["Deposit for"]) {
          // Wrong qty or missing visible "Deposit for" property
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
          (l) => Number(l.properties?._deposit_for) === vid,
        );
        if (!exists) {
          writes.push(
            postCart("/cart/add.js", {
              items: [
                {
                  id: DEPOSIT_VARIANT_ID,
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
      // text into the cell that wraps the hidden container
      const qtyCell =
        row.querySelector("quantity-popover-container")?.parentElement ||
        row.querySelector(".cart-item__quantity") ||
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
      (s, i) => (i.variant_id === DEPOSIT_VARIANT_ID ? s : s + i.quantity),
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

    const prefix = `${DEPOSIT_VARIANT_ID}:`;
    const rows = new Set();

    document
      .querySelectorAll("[data-quantity-line-key]")
      .forEach((el) => {
        const key = el.getAttribute("data-quantity-line-key") || "";
        if (!key.startsWith(prefix)) return;
        const row = el.closest("tr.cart-item, .cart-item, tr, li");
        if (row) rows.add(row);
      });

    if (depositHandle) {
      document
        .querySelectorAll(`a[href*="/products/${depositHandle}"]`)
        .forEach((a) => {
          const row = a.closest("tr.cart-item, .cart-item");
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
      const pageType = window.Shopify?.Analytics?.meta?.page?.pageType
        || document.body.dataset.template
        || "";

      if (pageType === "product" || document.getElementById("deposit-product-tags")) {
        updateProductPage();
      }

      // Sync deposit lines + re-lock controls (async)
      await syncDepositLine(cartOverride);

      // Product cards on collection/search pages
      if (pageType !== "product") {
        updateProductCards();
      }
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

  // Re-run on cart section re-render (AJAX cart updates)
  // Filter out mutations from our own injected elements to prevent loops
  let observerTimeout;
  const observer = new MutationObserver((mutations) => {
    // Lock deposit rows immediately — observer callbacks run after DOM
    // insertion but before paint, so the class lands before the row is
    // ever drawn (kills the quantity-popover flash on section re-render)
    lockDepositRows();
    patchCartCount();

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
    try {
      const rw = buildAtomicWrite(url, init);
      if (rw) {
        target = rw.url;
        targetInit = { ...init, body: rw.body };
      } else if (/\/cart\/add\b/.test(url)) {
        fireDepositForAdd(init);
      }
    } catch (e) {}

    return nativeFetch(target, targetInit).then((res) => {
      // Cart responses already contain the fresh cart — use it
      // directly instead of an extra /cart.js roundtrip
      res.clone().json().then((data) => {
        const cart = data && Array.isArray(data.items) ? data : null;
        setTimeout(() => updatePrices(cart), 50);
      }).catch(() => setTimeout(updatePrices, 50));
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

  // Re-run on variant change (product page)
  document.addEventListener("change", (e) => {
    if (e.target.matches('input[name="id"], select[name="id"]')) {
      setTimeout(updatePrices, 300);
    }
  });

  // Re-run on Shopify section render events
  document.addEventListener("shopify:section:load", updatePrices);
  document.addEventListener("cart:updated", updatePrices);
  document.addEventListener("cart:refresh", updatePrices);
})();
