/**
 * Deposit Price Display — Storefront Script
 *
 * Finds price elements on the storefront and appends deposit text
 * in the format: "{{ price }} + 0.10Euro per bottle"
 *
 * Reads configuration from the app's metafield via the Liquid block,
 * or falls back to a fetch to the app proxy if needed.
 */

(function () {
  "use strict";

  // Configuration is injected from the Liquid block via data attribute
  const depositBlock = document.querySelector("[data-deposit-block]");
  const configScript = document.getElementById("deposit-config");

  let config = {
    enabled: false,
    depositText: "0.10Euro per bottle",
  };

  if (configScript) {
    try {
      config = JSON.parse(configScript.textContent);
    } catch (e) {
      // Fall back to defaults
    }
  }

  if (!config.enabled) return;

  /**
   * Append deposit text after a price element.
   * Avoids duplicate appends.
   */
  function appendDepositText(priceElement) {
    if (!priceElement || priceElement.dataset.depositAdded) return;

    const depositSpan = document.createElement("span");
    depositSpan.className = "deposit-price-text";
    depositSpan.style.cssText = "font-size: 0.85em; color: #666; margin-left: 4px; display: inline;";
    depositSpan.textContent = " + " + config.depositText;

    priceElement.appendChild(depositSpan);
    priceElement.dataset.depositAdded = "true";
  }

  /**
   * Find and update all price elements on the page.
   * Targets common Dawn/OS 2.0 price classes.
   */
  function updatePrices() {
    // Product page price
    document
      .querySelectorAll(".price__regular .price-item, .price-item--regular, .product__price .price-item")
      .forEach(appendDepositText);

    // Product card prices
    document
      .querySelectorAll(".card__price .price-item, .price-item--regular")
      .forEach(appendDepositText);

    // Cart line item prices
    document
      .querySelectorAll(".cart-item__price .price-item, .cart__price .price-item")
      .forEach(appendDepositText);
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
        // Debounce
        clearTimeout(window.__depositUpdateTimer);
        window.__depositUpdateTimer = setTimeout(updatePrices, 100);
        break;
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Re-run on variant change (product page)
  document.addEventListener("change", (e) => {
    if (e.target.matches('input[name="id"], select[name="id"]')) {
      setTimeout(updatePrices, 200);
    }
  });

  // Re-run on Shopify section render events
  document.addEventListener("shopify:section:load", updatePrices);
  document.addEventListener("cart:updated", updatePrices);
  document.addEventListener("cart:refresh", updatePrices);
})();
