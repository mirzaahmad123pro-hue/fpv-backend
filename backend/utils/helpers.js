// Small shared helper functions used across controllers.

// Turns "Men's Running Shoes" into "mens-running-shoes"
function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Generates a unique-looking order number like: FPV-2026-8H3K2Q
function generateOrderNumber() {
  const year = new Date().getFullYear();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `FPV-${year}-${random}`;
}

// Formats a number as Pakistani Rupees text, e.g. 2999 -> "Rs. 2,999"
function formatPKR(amount) {
  const num = Number(amount) || 0;
  return 'Rs. ' + num.toLocaleString('en-PK', { maximumFractionDigits: 0 });
}

module.exports = { slugify, generateOrderNumber, formatPKR };
