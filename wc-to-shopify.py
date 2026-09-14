#!/usr/bin/env python3
"""
Convert WooCommerce product CSV export to Shopify product CSV import format.

Usage:
    python3 wc-to-shopify.py input.csv output_shopify.csv

Shopify CSV reference:
    https://help.shopify.com/en/manual/products/import-export/export-products
"""

import csv
import sys
import re
import os
from html import escape


def slugify(text):
    """Create a Shopify handle from a product title."""
    text = text.lower().strip()
    text = re.sub(r"[^a-z0-9\s-]", "", text)
    text = re.sub(r"[\s_]+", "-", text)
    text = re.sub(r"-+", "-", text)
    text = text.strip("-")
    return text or "product"


def clean_html(text):
    """Convert plain text / newlines to basic HTML for Shopify body."""
    if not text:
        return ""
    text = text.strip()
    # If already HTML (contains tags), return as-is
    if re.search(r"<\w+[^>]*>", text):
        return text
    # Convert newlines to <br> and wrap paragraphs
    paragraphs = text.split("\n\n")
    html_parts = []
    for p in paragraphs:
        p = p.strip()
        if p:
            p = escape(p)
            p = p.replace("\n", "<br>\n")
            html_parts.append(f"<p>{p}</p>")
    return "\n".join(html_parts)


def parse_categories(cat_string):
    """
    WooCommerce: "Water > Natural Mineral Water"
    Shopify: Type (last category), Vendor (first category)
    """
    if not cat_string:
        return "", ""
    parts = [p.strip() for p in cat_string.split(">")]
    vendor = parts[0] if parts else ""
    product_type = parts[-1] if parts else ""
    return vendor, product_type


def parse_tags(tags_string):
    """
    WooCommerce: "0.5L, AQUALAR, pH9+"
    Shopify: "0.5L, AQUALAR, pH9+" (same format, comma-separated)
    """
    if not tags_string:
        return ""
    tags = [t.strip() for t in tags_string.split(",") if t.strip()]
    return ", ".join(tags)


def parse_images(images_string):
    """
    WooCommerce: single URL or multiple URLs separated by commas/semicolons
    Returns list of URLs.
    """
    if not images_string:
        return []
    # Split by comma or semicolon
    urls = re.split(r"[,;]", images_string)
    return [u.strip() for u in urls if u.strip()]


def convert_price(price_str):
    """
    Convert WooCommerce price (may use comma as decimal separator)
    to Shopify format (dot as decimal separator).
    """
    if not price_str or not price_str.strip():
        return ""
    price_str = price_str.strip()
    # Handle European format: "1,20" -> "1.20"
    # But only if it's a single comma (not thousands separator)
    if "," in price_str and "." not in price_str:
        price_str = price_str.replace(",", ".")
    elif "," in price_str and "." in price_str:
        # Has both: remove commas (thousands), keep dot
        price_str = price_str.replace(",", "")
    try:
        return f"{float(price_str):.2f}"
    except ValueError:
        return price_str


def convert_stock(stock_str, in_stock_str):
    """
    Determine inventory quantity and policy.
    """
    stock = 0
    if stock_str and stock_str.strip():
        try:
            stock = int(stock_str.strip())
        except ValueError:
            stock = 0

    # WooCommerce "In stock?" = 1 means in stock, 0 means out of stock
    # If stock is empty but marked in stock, set a reasonable default
    if in_stock_str and in_stock_str.strip() == "1" and stock == 0:
        stock = 1  # At least 1 if marked in stock but no count

    return stock


def main():
    if len(sys.argv) < 3:
        print("Usage: python3 wc-to-shopify.py input.csv output_shopify.csv")
        sys.exit(1)

    input_file = sys.argv[1]
    output_file = sys.argv[2]

    if not os.path.exists(input_file):
        print(f"Error: Input file '{input_file}' not found")
        sys.exit(1)

    # Shopify CSV columns
    shopify_fields = [
        "Handle",
        "Title",
        "Body (HTML)",
        "Vendor",
        "Product Category",
        "Type",
        "Tags",
        "Published",
        "Option1 Name",
        "Option1 Value",
        "Option2 Name",
        "Option2 Value",
        "Option3 Name",
        "Option3 Value",
        "Variant SKU",
        "Variant Grams",
        "Variant Inventory Tracker",
        "Variant Inventory Qty",
        "Variant Inventory Policy",
        "Variant Fulfillment Service",
        "Variant Price",
        "Variant Compare At Price",
        "Variant Requires Shipping",
        "Variant Taxable",
        "Variant Barcode",
        "Image Src",
        "Image Position",
        "Image Alt Text",
        "Gift Card",
        "SEO Title",
        "SEO Description",
        "Google Shopping / Google Product Category",
        "Google Shopping / Gender",
        "Google Shopping / Age Group",
        "Google Shopping / MPN",
        "Google Shopping / Condition",
        "Google Shopping / Custom Product",
        "Google Shopping / Custom Label 0",
        "Google Shopping / Custom Label 1",
        "Google Shopping / Custom Label 2",
        "Google Shopping / Custom Label 3",
        "Google Shopping / Custom Label 4",
        "Variant Image",
        "Variant Weight Unit",
        "Variant Tax Code",
        "Cost per item",
        "Status",
    ]

    rows_written = 0
    image_rows = 0

    with open(input_file, "r", encoding="utf-8-sig", newline="") as fin, \
         open(output_file, "w", encoding="utf-8", newline="") as fout:

        reader = csv.DictReader(fin)
        writer = csv.DictWriter(fout, fieldnames=shopify_fields)
        writer.writeheader()

        for wc_row in reader:
            title = wc_row.get("Name", "").strip()
            if not title:
                continue

            handle = slugify(title)
            sku = wc_row.get("SKU", "").strip()
            description = wc_row.get("Description", "") or wc_row.get("Short description", "")
            vendor, product_type = parse_categories(wc_row.get("Categories", ""))
            tags = parse_tags(wc_row.get("Tags", ""))
            published = wc_row.get("Published", "1").strip() == "1"
            regular_price = convert_price(wc_row.get("Regular price", ""))
            sale_price = convert_price(wc_row.get("Sale price", ""))
            images = parse_images(wc_row.get("Images", ""))
            weight = wc_row.get("Weight (kg)", "").strip()
            stock_qty = convert_stock(wc_row.get("Stock", ""), wc_row.get("In stock?", ""))
            wc_type = wc_row.get("Type", "").strip()

            # Determine if virtual (no shipping)
            is_virtual = "virtual" in wc_type.lower()
            requires_shipping = "0" if is_virtual else "1"

            # Tax status
            tax_status = wc_row.get("Tax status", "taxable").strip()
            is_taxable = "true" if tax_status == "taxable" else "false"

            # Status
            status = "active" if published else "draft"

            # Compare at price (use regular price if sale price exists)
            compare_at_price = ""
            variant_price = regular_price
            if sale_price:
                variant_price = sale_price
                compare_at_price = regular_price

            # Weight in grams (Shopify uses grams)
            variant_grams = ""
            if weight:
                try:
                    variant_grams = str(int(float(weight) * 1000))
                except ValueError:
                    variant_grams = ""

            # Build the main product row
            base_row = {field: "" for field in shopify_fields}
            base_row.update({
                "Handle": handle,
                "Title": title,
                "Body (HTML)": clean_html(description),
                "Vendor": vendor,
                "Type": product_type,
                "Tags": tags,
                "Published": "true" if published else "false",
                "Option1 Name": "Title",
                "Option1 Value": "Default Title",
                "Variant SKU": sku,
                "Variant Grams": variant_grams,
                "Variant Inventory Tracker": "shopify",
                "Variant Inventory Qty": str(stock_qty),
                "Variant Inventory Policy": "deny" if stock_qty > 0 else "continue",
                "Variant Fulfillment Service": "manual",
                "Variant Price": variant_price,
                "Variant Compare At Price": compare_at_price,
                "Variant Requires Shipping": requires_shipping,
                "Variant Taxable": is_taxable,
                "Variant Barcode": "",
                "Gift Card": "No",
                "Status": status,
                "Variant Weight Unit": "kg" if weight else "",
            })

            # Set first image on the product row
            if images:
                base_row["Image Src"] = images[0]
                base_row["Image Position"] = "1"
                base_row["Image Alt Text"] = title
                base_row["Variant Image"] = images[0]

            writer.writerow(base_row)
            rows_written += 1

            # Write additional image rows (if more than one image)
            for i, img_url in enumerate(images[1:], start=2):
                img_row = {field: "" for field in shopify_fields}
                img_row.update({
                    "Handle": handle,
                    "Image Src": img_url,
                    "Image Position": str(i),
                    "Image Alt Text": title,
                })
                writer.writerow(img_row)
                image_rows += 1

    print(f"Converted {rows_written} products to {output_file}")
    print(f"  - {rows_written} product rows")
    print(f"  - {image_rows} additional image rows")
    print(f"  - {rows_written + image_rows} total rows")


if __name__ == "__main__":
    main()
