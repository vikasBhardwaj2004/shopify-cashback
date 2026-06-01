// src/utils/helpers.js

let batchCounter = 1000;

/**
 * Generate a unique batch reference like CB-1042.
 * In production, use a DB sequence or UUID instead.
 */
function generateBatchRef() {
  batchCounter++;
  return `CB-${batchCounter}`;
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
