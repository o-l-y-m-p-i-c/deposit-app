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
   * Main update function — runs on all page types.
   */
  function updatePrices() {
    const pageType = window.Shopify?.Analytics?.meta?.page?.pageType
      || document.body.dataset.template
      || "";

    if (pageType === "product" || document.getElementById("deposit-product-tags")) {
      updateProductPage();
    } else {
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
