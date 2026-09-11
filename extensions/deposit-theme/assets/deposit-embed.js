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
 * - Cart page & cart drawer: injects a separate "Bottle Deposit" row
 *   after each eligible product line
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
   * Inject a separate "Bottle Deposit" row in the cart after eligible
   * product lines, so the deposit appears as its own line item —
   * similar to how checkout shows it.
   *
   * Works on both cart page (table rows) and cart drawer (div items).
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
    document.querySelectorAll('[data-deposit-line="true"]').forEach((el) => {
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

      // Find the cart DOM element for this product line
      const key = item.key;
      const variantId = String(item.variant_id);
      let lineEl = null;

      // Try data-key (Dawn uses this on cart items)
      if (key) {
        lineEl = document.querySelector(`[data-key="${key}"]`);
      }
      // Try data-variant-id
      if (!lineEl && variantId) {
        lineEl = document.querySelector(
          `[data-variant-id="${variantId}"], [data-cart-item-variant-id="${variantId}"]`,
        );
      }
      // Try data-id (numeric variant ID)
      if (!lineEl && variantId) {
        lineEl = document.querySelector(`[data-id="${variantId}"]`);
      }
      // Try matching by product handle in links
      if (!lineEl) {
        const link = document.querySelector(`a[href*="/products/${handle}"]`);
        if (link) {
          lineEl = link.closest(
            ".cart-item, .cart__row, .cart-row, .cart-drawer__item, li, tr",
          );
        }
      }

      if (!lineEl) continue;

      // Deposit amount for this line (deposit × quantity)
      const depositPerUnit = parseFloat(config.depositAmount) || 0;
      const depositTotal = (depositPerUnit * item.quantity).toFixed(2);

      // Build the deposit row based on the theme's cart structure
      const isTableRow = lineEl.tagName === "TR";
      const depositRow = document.createElement(lineEl.tagName);
      depositRow.dataset.depositLine = "true";
      depositRow.dataset.depositFor = handle;

      // Copy classes from the original line for consistent styling
      depositRow.className = lineEl.className;

      if (isTableRow) {
        // Cart page table row (Dawn and similar)
        const cols = lineEl.querySelectorAll("td, th");
        const colCount = cols.length || 5;
        let cells = "";

        for (let i = 0; i < colCount; i++) {
          if (i === 0) {
            // Image/media cell — empty
            cells += `<td class="cart-item__media"></td>`;
          } else if (i === 1) {
            // Title cell
            cells += `<td class="cart-item__name">
              <span style="font-weight: 500;">Bottle Deposit</span>
              <span style="display:block; font-size:0.8em; color:#666;">Included with ${item.product_title || item.title}</span>
            </td>`;
          } else if (i === colCount - 1) {
            // Total cell
            cells += `<td class="cart-item__totals">
              <span class="price-item">${depositTotal} ${shopCurrency}</span>
            </td>`;
          } else if (i === colCount - 2) {
            // Price per unit cell
            cells += `<td class="cart-item__price">
              <span class="price-item">${config.depositAmount} ${shopCurrency}</span>
            </td>`;
          } else {
            // Quantity cell
            cells += `<td class="cart-item__quantity">
              <span>${item.quantity}</span>
            </td>`;
          }
        }
        depositRow.innerHTML = cells;
      } else {
        // Cart drawer item or generic div
        depositRow.innerHTML = `
          <div style="display:flex; align-items:center; gap:0.75rem; padding:0.5rem 0; border-top:1px solid rgba(0,0,0,0.06);">
            <div style="flex:1;">
              <div style="font-weight:500; font-size:0.9em;">Bottle Deposit</div>
              <div style="font-size:0.8em; color:#666;">Included with ${item.product_title || item.title}</div>
            </div>
            <div style="font-size:0.9em; font-weight:500;">
              ${depositTotal} ${shopCurrency}
            </div>
          </div>
        `;
      }

      // Insert after the product line
      lineEl.parentNode.insertBefore(depositRow, lineEl.nextSibling);
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

    // Cart page and cart drawer — always check
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
