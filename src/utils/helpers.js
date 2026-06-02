// src/utils/helpers.js

/**
 * Generate a unique batch reference.
 * Uses timestamp + random to avoid collision on server restart.
 * Example: CB-17488344-x7k2
 */
function generateBatchRef() {
  const ts = Date.now().toString(36).toUpperCase();         // e.g. "LXKR92"
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase(); // e.g. "K3F1"
  return `CB-${ts}-${rand}`;
}

/**
 * Format a number as Indian currency string.
 */
function formatINR(amount) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format(amount);
}

/**
 * Add N days to a date.
 */
function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

module.exports = { generateBatchRef, formatINR, addDays };
