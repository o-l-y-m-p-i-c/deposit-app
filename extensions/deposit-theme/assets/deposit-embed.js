/**
 * Deposit Price Display — Storefront Script
 *
 * 1. Appends "+ 0.10 EUR per bottle" text on eligible product prices
 *    (product pages, product cards).
 *
 * 2. Manages the deposit as a real cart line ("line" mode):
 *    - Auto-adds the deposit product when eligible items are in the cart
 *    - Keeps its quantity equal to the total eligible quantity
 *    - Removes it when no eligible items remain
 *    - Hides quantity/remove controls on the deposit row
 *    The deposit-validation Function enforces the same rule at checkout,
 *    so tampering with the line can't bypass the deposit.
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
  // Guard flag to prevent overlapping cart syncs
  let isSyncing = false;

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
   */
  async function getProductTags(handle) {
    if (tagCache.has(handle)) return tagCache.get(handle);
    try {
      const res = await fetch(`/products/${handle}.js`);
      if (!res.ok) {
        tagCache.set(handle, []);
        return [];
      }
      const product = await res.json();
      const tags = product.tags || [];
      tagCache.set(handle, tags);
      return tags;
    } catch (e) {
      return [];
    }
  }

  /**
   * Fetch the set of product handles in a collection (cached).
   * Uses the storefront JSON endpoint /collections/{handle}/products.json.
   */
  function getCollectionProducts(handle) {
    if (collectionCache.has(handle)) return collectionCache.get(handle);
    const promise = (async () => {
      const handles = new Set();
      try {
        for (let page = 1; page <= 10; page++) {
          const res = await fetch(
            `/collections/${handle}/products.json?limit=250&page=${page}`,
          );
          if (!res.ok) break;
          const data = await res.json();
          const products = data.products || [];
          products.forEach((p) => handles.add(p.handle));
          if (products.length < 250) break;
        }
      } catch (e) {
        // Endpoint unavailable — treat as empty
      }
      return handles;
    })();
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
      const tags = await getProductTags(handle);
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
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
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
      if (
        typeof window.publish === "function" &&
        window.PUB_SUB_EVENTS?.cartUpdate &&
        cartData?.sections
      ) {
        window.publish(window.PUB_SUB_EVENTS.cartUpdate, {
          source: "deposit-sync",
          cartData,
        });
      }
    } catch (e) {
      // Not a pubsub theme — fall through to DOM events
    }
    document.dispatchEvent(new CustomEvent("cart:updated", { detail: { cart: cartData } }));
    document.dispatchEvent(new CustomEvent("cart:refresh"));
  }

  /**
   * Ensure the deposit line exists and its quantity equals the total
   * quantity of eligible items. Idempotent — only writes on mismatch.
   */
  async function syncDepositLine() {
    if (!DEPOSIT_VARIANT_ID || isSyncing) return;
    isSyncing = true;

    try {
      const res = await fetch("/cart.js");
      if (!res.ok) return;
      const cart = await res.json();

      let expected = 0;
      let depositLine = null;

      for (const item of cart.items || []) {
        if (item.variant_id === DEPOSIT_VARIANT_ID) {
          depositLine = item;
          depositHandle = item.handle || depositHandle;
          continue;
        }
        if (await isEligibleItem(item)) {
          expected += item.quantity;
        }
      }

      let cartData = null;
      if (expected > 0 && !depositLine) {
        cartData = await postCart("/cart/add.js", {
          items: [{ id: DEPOSIT_VARIANT_ID, quantity: expected }],
          sections: CART_SECTIONS,
          sections_url: window.location.pathname,
        });
      } else if (depositLine && depositLine.quantity !== expected) {
        cartData = await postCart("/cart/change.js", {
          id: depositLine.key,
          quantity: expected,
          sections: CART_SECTIONS,
          sections_url: window.location.pathname,
        });
      } else if (expected === 0 && depositLine) {
        cartData = await postCart("/cart/change.js", {
          id: depositLine.key,
          quantity: 0,
          sections: CART_SECTIONS,
          sections_url: window.location.pathname,
        });
      }

      if (cartData) {
        refreshCartUi(cartData);
      }
      lockDepositRows();
    } catch (e) {
      // Sync failures are non-fatal — the validation function still
      // enforces the deposit at checkout.
    } finally {
      isSyncing = false;
    }
  }

  /**
   * Inject the CSS that hides interactive controls on the deposit row.
   */
  function injectLockStyles() {
    if (document.getElementById("deposit-lock-styles")) return;
    const style = document.createElement("style");
    style.id = "deposit-lock-styles";
    style.textContent = `
      .deposit-line-locked quantity-input,
      .deposit-line-locked quantity-popover,
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
    if (!row || row.dataset.depositLocked === "true") return;
    row.dataset.depositLocked = "true";
    row.classList.add("deposit-line-locked");

    const qtyInput = row.querySelector(
      "input[name='updates[]'], input[data-quantity-line-key]",
    );
    const qty = qtyInput?.value || "";
    const qtyCell =
      row.querySelector(".cart-item__quantity") || qtyInput?.closest("td");
    if (qtyCell && !qtyCell.querySelector(".deposit-qty-static")) {
      const span = document.createElement("span");
      span.className = "deposit-qty-static";
      span.style.cssText = "font-size: 0.9em; color: #666;";
      span.textContent = qty;
      qtyCell.appendChild(span);
    }
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
   */
  async function updatePrices() {
    if (isUpdating) return;
    isUpdating = true;

    try {
      const pageType = window.Shopify?.Analytics?.meta?.page?.pageType
        || document.body.dataset.template
        || "";

      if (pageType === "product" || document.getElementById("deposit-product-tags")) {
        updateProductPage();
      }

      // Sync the deposit line + re-lock controls (async)
      await syncDepositLine();

      // Product cards on collection/search pages
      if (pageType !== "product") {
        updateProductCards();
      }
    } finally {
      // Release the guard after async operations complete + short cooldown
      isUpdating = false;
    }
  }

  // Run on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", updatePrices);
  } else {
    updatePrices();
  }

  // Retry once after 1s in case <cart-items> renders async after DOMContentLoaded
  setTimeout(updatePrices, 1000);

  // Re-run on cart section re-render (AJAX cart updates)
  // Filter out mutations from our own injected elements to prevent loops
  let observerTimeout;
  const observer = new MutationObserver((mutations) => {
    // Skip if already updating
    if (isUpdating) return;

    for (const mutation of mutations) {
      // Skip mutations that only involve our own elements
      const addedByUs = Array.from(mutation.addedNodes).every(
        (n) =>
          n.nodeType === 1 &&
          (n.dataset?.depositLine === "true" ||
            n.classList?.contains("deposit-qty-static")),
      );
      if (addedByUs && mutation.addedNodes.length > 0) continue;

      if (mutation.addedNodes.length > 0) {
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
  const cartWriteRe = /\/cart\/(add|change|update|clear)\b/;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input?.url || "";
    const p = nativeFetch(input, init);
    if (cartWriteRe.test(url)) {
      return p.then((res) => {
        setTimeout(updatePrices, 250);
        return res;
      });
    }
    return p;
  };

  // Dawn-style pubsub (used by Dawn, Prestige and other themes)
  try {
    if (typeof window.subscribe === "function" && window.PUB_SUB_EVENTS?.cartUpdate) {
      window.subscribe(window.PUB_SUB_EVENTS.cartUpdate, () =>
        setTimeout(updatePrices, 250),
      );
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
