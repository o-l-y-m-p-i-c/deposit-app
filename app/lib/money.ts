/** Cents → localized money string (shared by server and browser code). */
export function formatMoney(cents: number, currencyCode: string, locale = "en-US") {
  return new Intl.NumberFormat(locale, { style: "currency", currency: currencyCode }).format(
    cents / 100,
  );
}
