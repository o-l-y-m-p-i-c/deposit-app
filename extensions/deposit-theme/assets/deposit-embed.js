/**
 * Deposit Price Display — Storefront Script
 *
 * Finds price elements on the storefront and appends deposit text
 * in the format: "+ 0.10 EUR per bottle"
 *
 * Only shows deposit text on eligible products (matching include tags,
 * not matching exclude tags).
 *
 * Works on:
 * - Product pages: reads product tags from #deposit-product-tags
 * - Product cards (collection/search pages): fetches product tags via
 *   /products/{handle}.js and caches results
 * - Cart page & cart drawer: injects deposit info inside the quantity
 *   cell, under <quantity-popover>
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

  // Use the shop's active currency
  const shopCurrency =
    window.Shopify?.currency?.active ||
    window.Shopify?.currency ||
    config.currencyCode ||
    "EUR";

  const depositText = `${config.depositAmount} ${shopCurrency} per bottle`;

  const includeTags = (config.includeTags || []).map((t) => t.toLowerCase());
  const excludeTags = (config.excludeTags || []).map((t) => t.toLowerCase());

  // Cache of product handle -> tags
  const tagCache = new Map();

  // Guard flag to prevent infinite MutationObserver loop
  let isUpdating = false;

  /**
   * Format a number in European style (e.g., 0.10 -> "0,10")
   */
  function formatPrice(amount) {
    return amount.replace(".", ",");
  }

  /**
   * Check if a product is eligible for deposit based on its tags.
   */
  function isEligible(tags) {
    if (!Array.isArray(tags)) return false;
    const lower = tags.map((t) => t.toLowerCase());
    const included = includeTags.some((t) => lower.includes(t));
    const excluded = excludeTags.some((t) => lower.includes(t));
    return included && !excluded;
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

    if (!isEligible(productTags)) return;

    document
      .querySelectorAll(
        ".price__regular .price-item, .price-item--regular, .product__price .price-item, .product-single__price",
      )
      .forEach(appendDepositText);
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

      const priceEl = card.querySelector(
        ".price-item--regular, .price__regular .price-item, .card__price .price-item, .product-card__price",
      );
      if (!priceEl || priceEl.dataset.depositAdded) return;

      cardsToUpdate.push({ priceEl, handle });
    });

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
      cardsToUpdate
        .filter((c) => c.handle === handle)
        .forEach((c) => appendDepositText(c.priceEl));
    });
  }

  /**
   * Find ALL <tr> cart rows for a given cart line item.
   * On the cart page, both the cart table AND the cart drawer are in the DOM,
   * so we need to find and inject into both.
   *
   * Dawn theme uses:
   *   Cart page:  <tr class="cart-item" id="CartItem-{index}">
   *   Cart drawer: <tr class="cart-item" id="CartDrawer-Item-{index}">
   */
  function findCartRows(item) {
    const key = item.key;
    const index = item.line;
    const rows = [];

    // Strategy 1: Find by quantity input with data-quantity-line-key
    if (key) {
      document
        .querySelectorAll(`input[data-quantity-line-key="${key}"]`)
        .forEach((input) => {
          const row = input.closest("tr.cart-item");
          if (row && !rows.includes(row)) rows.push(row);
        });
    }

    // Strategy 2: Find by data-index on the input
    if (rows.length === 0 && index) {
      document
        .querySelectorAll(`input[data-index="${index}"]`)
        .forEach((input) => {
          const row = input.closest("tr.cart-item");
          if (row && !rows.includes(row)) rows.push(row);
        });
    }

    // Strategy 3: Find by product link inside tr.cart-item
    if (rows.length === 0) {
      document
        .querySelectorAll(`tr.cart-item a[href*="/products/${item.handle}"]`)
        .forEach((link) => {
          const row = link.closest("tr.cart-item");
          if (row && !rows.includes(row)) rows.push(row);
        });
    }

    return rows;
  }

  /**
   * Inject a separate "Bottle Deposit" <tr> row after each eligible
   * product line in the cart — same style as checkout.
   *
   * Dawn theme compatible:
   *   Cart page:  5 columns (media, details, mobile-totals, qty, desktop-totals)
   *   Cart drawer: 4 columns (media, details, totals, qty)
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

    // Remove previously injected deposit rows (clean slate for re-render)
    document.querySelectorAll('tr[data-deposit-line="true"]').forEach((el) => {
      el.remove();
    });

    for (const item of cart.items) {
      const handle = item.handle;
      if (!handle) continue;

      // Skip the deposit product itself
      if (item.title === "Bottle Deposit" || handle === "bottle-deposit") {
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

      // Find ALL <tr> cart rows (cart page + cart drawer may both be in DOM)
      const lineEls = findCartRows(item);
      if (lineEls.length === 0) continue;

      // Deposit amount for this line
      const depositPerUnit = parseFloat(config.depositAmount) || 0;
      const depositTotal = (depositPerUnit * item.quantity).toFixed(2);
      const depositTotalFormatted = formatPrice(depositTotal);
      const productTitle = item.product_title || item.title;

      // Inject a deposit row after each matching product row
      for (const lineEl of lineEls) {
        // Skip if this row already has a deposit row after it
        const next = lineEl.nextElementSibling;
        if (next && next.dataset.depositLine === "true" && next.dataset.depositFor === handle) {
          continue;
        }

        // Detect cart type: drawer vs page
        const isDrawer = lineEl.id.startsWith("CartDrawer-");

        // Build the deposit <tr> with matching column structure
        const depositRow = document.createElement("tr");
        depositRow.className = "cart-item";
        depositRow.dataset.depositLine = "true";
        depositRow.dataset.depositFor = handle;
        depositRow.style.cssText = "opacity: 0.7; border-top: 1px dashed rgba(0,0,0,0.08);";

        if (isDrawer) {
          // Cart drawer: 4 columns (media, details, totals, quantity)
          depositRow.innerHTML = `
            <td class="cart-item__media" role="cell" headers="CartDrawer-ColumnProductImage"></td>
            <td class="cart-item__details" role="cell" headers="CartDrawer-ColumnProduct">
              <div class="cart-item__title">
                <span class="cart-item__name h4 break" style="font-size: 0.9em; font-weight: 500;">Bottle Deposit</span>
              </div>
              <div class="product-option" style="font-size: 0.8em; color: #666;">Included with ${productTitle}</div>
            </td>
            <td class="cart-item__totals right" role="cell" headers="CartDrawer-ColumnTotal">
              <div class="cart-item__price-wrapper">
                <span class="price price--end">${depositTotalFormatted} ${shopCurrency}</span>
              </div>
            </td>
            <td class="cart-item__quantity" role="cell" headers="CartDrawer-ColumnQuantity">
              <span style="font-size: 0.9em; color: #666;">${item.quantity}</span>
            </td>
          `;
        } else {
          // Cart page: 5 columns (media, details, mobile-totals, quantity, desktop-totals)
          depositRow.innerHTML = `
            <td class="cart-item__media"></td>
            <td class="cart-item__details">
              <div class="cart-item__title">
                <span class="cart-item__name h4 break" style="font-size: 0.9em; font-weight: 500;">Bottle Deposit</span>
              </div>
              <div class="product-option" style="font-size: 0.8em; color: #666;">Included with ${productTitle}</div>
            </td>
            <td class="cart-item__totals right medium-hide large-up-hide">
              <div class="cart-item__price-wrapper">
                <span class="price price--end">${depositTotalFormatted} ${shopCurrency}</span>
              </div>
            </td>
            <td class="cart-item__quantity">
              <span style="font-size: 0.9em; color: #666;">${item.quantity}</span>
            </td>
            <td class="cart-item__totals right small-hide">
              <div class="cart-item__price-wrapper">
                <span class="price price--end">${depositTotalFormatted} ${shopCurrency}</span>
              </div>
            </td>
          `;
        }

        // Insert after the product row
        lineEl.parentNode.insertBefore(depositRow, lineEl.nextSibling);
      }
    }
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

      // Cart page and cart drawer — always check (async)
      await updateCart();

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
        (n) => n.nodeType === 1 && n.dataset && n.dataset.depositLine === "true",
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
