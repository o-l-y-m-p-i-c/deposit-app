/**
 * Deposit Price Display — Storefront Script
 *
 * Finds price elements on the storefront and appends deposit text
 * in the format: "+ 0.10Euro per bottle"
 *
 * Only shows deposit text on eligible products (matching include tags,
 * not matching exclude tags).
 *
 * Works on:
 * - Product pages: reads product tags from #deposit-product-tags
 * - Product cards (collection/search pages): fetches product tags via
 *   /products/{handle}.js and caches results
 */

(function () {
  "use strict";

  const configScript = document.getElementById("deposit-config");
  let config = {
    enabled: false,
    depositAmount: "0.10",
    currencyCode: "EUR",
    includeTags: [],
    excludeTags: [],
  };

  if (configScript) {
    try {
      config = JSON.parse(configScript.textContent);
    } catch (e) {
      // Fall back to defaults
    }
  }

  if (!config.enabled) return;

  // Use the shop's active currency (available on storefront via Shopify.global)
  const shopCurrency =
    window.Shopify?.currency?.active ||
    window.Shopify?.currency ||
    config.currencyCode ||
    "EUR";

  const depositText = `${config.depositAmount} ${shopCurrency} per bottle`;

  const includeTags = (config.includeTags || []).map((t) => t.toLowerCase());
  const excludeTags = (config.excludeTags || []).map((t) => t.toLowerCase());

  // Cache of product handle -> tags (fetched via /products/{handle}.js)
  const tagCache = new Map();

  /**
   * Check if a product is eligible for deposit based on its tags.
   * Must match at least one include tag and no exclude tags.
   */
  function isEligible(tags) {
    if (!Array.isArray(tags)) return false;
    const lower = tags.map((t) => t.toLowerCase());
    const included = includeTags.some((t) => lower.includes(t));
    const excluded = excludeTags.some((t) => lower.includes(t));
    return included && !excluded;
  }

  /**
   * Append deposit text after a price element.
   * Avoids duplicate appends.
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
   * Update prices on a product page.
   * Product tags are available from #deposit-product-tags (injected by Liquid).
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

    if (!isEligible(productTags)) return;

    document
      .querySelectorAll(
        ".price__regular .price-item, .price-item--regular, .product__price .price-item, .product-single__price",
      )
      .forEach(appendDepositText);
  }

  /**
   * Update prices on product cards (collection pages, search results).
   * Fetches product tags via /products/{handle}.js for each unique card.
   */
  function updateProductCards() {
    // Find all product card links
    const cardLinks = document.querySelectorAll(
      'a[href*="/products/"]',
    );

    // Map of price container -> product handle
    const cardsToUpdate = [];

    cardLinks.forEach((link) => {
      const href = link.getAttribute("href");
      const match = href.match(/\/products\/([^/?#]+)/);
      if (!match) return;
      const handle = match[1];

      // Find the closest price element near this card
      const card = link.closest(
        ".card, .product-card, .grid__item, .collection-list__item, li",
      );
      if (!card) return;

      const priceEl = card.querySelector(
        ".price-item--regular, .price__regular .price-item, .card__price .price-item, .product-card__price",
      );
      if (!priceEl || priceEl.dataset.depositAdded) return;

      cardsToUpdate.push({ priceEl, handle });
    });

    // Group by handle to avoid duplicate fetches
    const handles = [...new Set(cardsToUpdate.map((c) => c.handle))];

    handles.forEach(async (handle) => {
      let tags;

      if (tagCache.has(handle)) {
        tags = tagCache.get(handle);
      } else {
        try {
          const res = await fetch(`/products/${handle}.js`);
          if (!res.ok) return;
          const product = await res.json();
          tags = product.tags || [];
          tagCache.set(handle, tags);
        } catch (e) {
          return;
        }
      }

      if (!isEligible(tags)) return;

      // Apply to all cards with this handle
      cardsToUpdate
        .filter((c) => c.handle === handle)
        .forEach((c) => appendDepositText(c.priceEl));
    });
  }

  /**
   * Annotate cart line items with deposit info.
   * Fetches /cart.js, checks eligibility per line, and appends
   * "incl. €0.10 deposit" text next to eligible line item prices.
   *
   * Works on both the cart page and AJAX cart drawers.
   */
  async function updateCart() {
    let cart;
    try {
      const res = await fetch("/cart.js");
      if (!res.ok) return;
      cart = await res.json();
    } catch (e) {
      return;
    }

    if (!cart.items || cart.items.length === 0) return;

    // Skip the deposit product itself
    for (const item of cart.items) {
      const handle = item.handle;
      if (!handle) continue;

      // Skip the deposit product
      if (item.title === "Bottle Deposit" || (item.product_tags && item.product_tags.includes("deposit"))) {
        continue;
      }

      let tags;
      if (tagCache.has(handle)) {
        tags = tagCache.get(handle);
      } else {
        try {
          const res = await fetch(`/products/${handle}.js`);
          if (!res.ok) continue;
          const product = await res.json();
          tags = product.tags || [];
          tagCache.set(handle, tags);
        } catch (e) {
          continue;
        }
      }

      if (!isEligible(tags)) continue;

      // Find the DOM element for this cart line item.
      // Match by product handle in links, or by variant ID in data attributes.
      const variantId = String(item.variant_id);
      const lineEls = [];

      // Try data-variant-id attribute (common in Dawn and many themes)
      document
        .querySelectorAll(`[data-variant-id="${variantId}"], [data-cart-item-variant-id="${variantId}"]`)
        .forEach((el) => lineEls.push(el));

      // Try matching by product handle in links
      if (lineEls.length === 0) {
        document
          .querySelectorAll(`a[href*="/products/${handle}"]`)
          .forEach((link) => {
            const row = link.closest(
              ".cart-item, .cart__row, .cart-row, .cart-drawer__item, li, tr",
            );
            if (row) lineEls.push(row);
          });
      }

      // For each matching cart line element, find the price element and annotate
      for (const lineEl of lineEls) {
        const priceEl = lineEl.querySelector(
          ".cart-item__price .price-item, .cart-item__price, .cart__price .price-item, .cart__price, .cart-drawer__price, .price-item--regular, .price-item",
        );
        if (priceEl && !priceEl.dataset.depositAdded) {
          const depositSpan = document.createElement("span");
          depositSpan.className = "deposit-price-text deposit-cart-text";
          depositSpan.style.cssText =
            "font-size: 0.85em; color: #666; display: block; margin-top: 2px;";
          depositSpan.textContent = `incl. ${depositText}`;
          priceEl.appendChild(depositSpan);
          priceEl.dataset.depositAdded = "true";
        }
      }
    }
  }

  /**
   * Main update function — runs on all page types.
   */
  function updatePrices() {
    const pageType = window.Shopify?.Analytics?.meta?.page?.pageType
      || document.body.dataset.template
      || "";

    if (pageType === "product" || document.getElementById("deposit-product-tags")) {
      updateProductPage();
    }

    // Cart page and cart drawer — always check, since drawers can appear on any page
    updateCart();

    // Product cards on collection/search pages
    if (pageType !== "product") {
      updateProductCards();
    }
  }

  // Run on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", updatePrices);
  } else {
    updatePrices();
  }

  // Re-run on cart section re-render (AJAX cart updates)
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        clearTimeout(window.__depositUpdateTimer);
        window.__depositUpdateTimer = setTimeout(updatePrices, 200);
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

  // Re-run on Shopify section render events
  document.addEventListener("shopify:section:load", updatePrices);
  document.addEventListener("cart:updated", updatePrices);
  document.addEventListener("cart:refresh", updatePrices);
})();
