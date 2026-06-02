// src/services/cashback.service.js
// ─────────────────────────────────────────────────────────────────────────────
// All cashback business logic:
// - calculateOrderCashback() → cashback earned on an order
// - calculateWalletUsage()   → how much wallet can be applied at checkout
//
// Rules:
//   1. Cashback only on products ₹299+
//   2. GST deducted using Shopify's actual total_tax (no assumption)
//   3. First order → 10% extra discount THEN cashback on remaining excl. GST
//   4. 2nd+ orders → no extra discount, cashback on price excl. GST
//   5. Wallet use (2nd+ orders): customer can use MAX of:
//        Option A → 40% of product value (excl. GST)
//        Option B → 33% of wallet balance
// ─────────────────────────────────────────────────────────────────────────────

const db = require('../config/database');

// ── Settings (can be moved to DB / env later) ────────────────────────────────
const SETTINGS = {
  minOrderValue:        299,   // cashback only if product price >= ₹299
  firstOrderExtraDisc:  10,    // % extra discount on first order
  firstOrderCashbackPct:100,   // % cashback of price-excl-GST (1st order)
  repeatCashbackPct:   100,    // % cashback of price-excl-GST (repeat orders)
  walletUsagePctOfProduct: 40, // Option A: max % of product value (excl GST)
  walletUsagePctOfBalance: 33, // Option B: max % of wallet balance
  cashbackExpiryDays:   30,    // days before cashback expires
};

// ─────────────────────────────────────────────────────────────────────────────
// calculateOrderCashback()
//
// @param {object} params
//   - subtotal      {number}  order subtotal (tax-inclusive, from Shopify)
//   - totalTax      {number}  actual GST amount from Shopify webhook
//   - isFirstOrder  {boolean}
//
// @returns {object}
//   - cashbackAmount   {number}
//   - breakdown        {object}  full audit trail
// ─────────────────────────────────────────────────────────────────────────────
function calculateOrderCashback({ subtotal, totalTax, isFirstOrder }) {
  const s = SETTINGS;

  // Rule 1: Minimum order value check
  if (subtotal < s.minOrderValue) {
    return {
      cashbackAmount: 0,
      breakdown: {
        subtotal,
        reason: `Order below ₹${s.minOrderValue} — no cashback`,
      },
    };
  }

  // Step 1: Apply first-order 10% extra discount (on subtotal, tax-inclusive)
  let discountedPrice = subtotal;
  let firstOrderDiscountAmt = 0;

  if (isFirstOrder) {
    firstOrderDiscountAmt = parseFloat(
      (subtotal * (s.firstOrderExtraDisc / 100)).toFixed(2)
    );
    discountedPrice = parseFloat((subtotal - firstOrderDiscountAmt).toFixed(2));
  }

  // Step 2: Deduct actual GST (from Shopify's total_tax field)
  // Shopify sends total_tax proportional to the full subtotal.
  // If a discount was applied we scale the tax proportionally.
  let scaledTax = totalTax;
  if (isFirstOrder && subtotal > 0) {
    scaledTax = parseFloat(((totalTax / subtotal) * discountedPrice).toFixed(2));
  }

  const priceExclGst = parseFloat((discountedPrice - scaledTax).toFixed(2));

  // Step 3: Cashback = 100% of price excl. GST
  const cashbackPct = isFirstOrder
    ? s.firstOrderCashbackPct
    : s.repeatCashbackPct;

  const cashbackAmount = parseFloat(
    (priceExclGst * (cashbackPct / 100)).toFixed(2)
  );

  return {
    cashbackAmount: Math.max(0, cashbackAmount),
    breakdown: {
      subtotal,
      firstOrderDiscount: firstOrderDiscountAmt,
      discountedPrice,
      shopifyTax: totalTax,
      scaledTax,
      priceExclGst,
      cashbackPct,
      cashbackAmount: Math.max(0, cashbackAmount),
      isFirstOrder,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// calculateWalletUsage()
//
// For 2nd+ orders: customer can use the HIGHER of:
//   Option A → 40% of product value excl. GST
//   Option B → 33% of current wallet balance
//
// First order: no wallet usage allowed (cashback is being earned, not spent)
//
// @param {object} params
//   - productPrice   {number}  product subtotal (tax-inclusive)
//   - totalTax       {number}  actual GST from Shopify
//   - walletBalance  {number}  customer's current wallet balance
//   - isFirstOrder   {boolean}
//
// @returns {object}
//   - maxUsable      {number}  max wallet amount customer can apply
//   - optionA        {number}  40% of product excl. GST
//   - optionB        {number}  33% of wallet balance
//   - recommended    {string}  which option gives more
// ─────────────────────────────────────────────────────────────────────────────
function calculateWalletUsage({ productPrice, totalTax, walletBalance, isFirstOrder }) {
  const s = SETTINGS;

  if (isFirstOrder) {
    return {
      maxUsable: 0,
      optionA: 0,
      optionB: 0,
      recommended: null,
      reason: 'Wallet cannot be used on first order',
    };
  }

  const productExclGst = parseFloat((productPrice - totalTax).toFixed(2));

  const optionA = parseFloat(
    (productExclGst * (s.walletUsagePctOfProduct / 100)).toFixed(2)
  );
  const optionB = parseFloat(
    (walletBalance * (s.walletUsagePctOfBalance / 100)).toFixed(2)
  );

  const maxUsable = parseFloat(Math.max(optionA, optionB).toFixed(2));
  // Cannot use more than actual wallet balance
  const finalUsable = parseFloat(Math.min(maxUsable, walletBalance).toFixed(2));

  return {
    maxUsable: finalUsable,
    optionA,
    optionB,
    recommended: optionA >= optionB ? 'A' : 'B',
    breakdown: {
      productPrice,
      totalTax,
      productExclGst,
      walletBalance,
      optionA_desc: `${s.walletUsagePctOfProduct}% of ₹${productExclGst} (product excl. GST)`,
      optionB_desc: `${s.walletUsagePctOfBalance}% of ₹${walletBalance} (wallet balance)`,
    },
  };
}

module.exports = { calculateOrderCashback, calculateWalletUsage, SETTINGS };
