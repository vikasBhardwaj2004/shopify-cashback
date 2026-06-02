// src/routes/wallet.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Customer-facing wallet API. Called from storefront JS or checkout extensions.
//
// GET  /api/wallet/:customerId                → wallet summary + balance
// GET  /api/wallet/:customerId/calculate      → preview cashback for a cart
// POST /api/wallet/:customerId/redeem         → apply wallet credit to order
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const router = express.Router();
const { z } = require("zod");
const cashbackService = require("../services/cashback.service");
const { validateShopSession } = require("../middleware/auth.middleware");
const logger = require("../utils/logger");

// ── CORS — allow Shopify storefront to call this API ─────────────────────────
router.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-shopify-shop-domain");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// All wallet routes require a valid Shopify session header
router.use(validateShopSession);

// ── GET /api/wallet/:customerId ───────────────────────────────────────────────
// Returns full wallet summary: balance, active batches, transaction history
router.get("/:customerId", async (req, res) => {
  const { customerId } = req.params;
  const { shopId } = req; // set by validateShopSession middleware

  const summary = await cashbackService.getWalletSummary({
    shopId,
    customerId: decodeURIComponent(customerId),
  });

  summary.totalEarned  = summary.totalEarned  || 0;
  summary.totalUsed    = summary.totalUsed    || 0;
  summary.totalExpired = summary.totalExpired || 0;
  summary.balance      = summary.balance      || 0;

  res.json(summary);
});

// ── GET /api/wallet/:customerId/calculate ─────────────────────────────────────
// Preview: given cart subtotal + actual tax from Shopify, returns:
//  - cashback customer will earn
//  - how much wallet balance they can apply (Option A vs Option B)
//  - final amount payable after wallet deduction
//
// Query params:
//   subtotal  → cart subtotal (tax-inclusive, from Shopify)
//   totalTax  → actual GST amount from Shopify (not assumed)
const calculateSchema = z.object({
  subtotal: z.coerce.number().positive(),
  totalTax: z.coerce.number().min(0),
});

router.get("/:customerId/calculate", async (req, res) => {
  const { shopId } = req;
  const parsed = calculateSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { subtotal, totalTax } = parsed.data;
  const { customerId } = req.params;
  const decodedCustomerId = decodeURIComponent(customerId);

  const isFirstOrder = await cashbackService.isFirstOrder({
    shopId,
    customerId: decodedCustomerId,
  });

  // Get current wallet balance
  const walletSummary = await cashbackService.getWalletSummary({
    shopId,
    customerId: decodedCustomerId,
  });

  const walletBalance = walletSummary.balance || 0;

  // Calculate cashback to be earned
  const orderCalc = cashbackService.calculateOrderCashback({
    subtotal,
    totalTax,
    isFirstOrder,
  });

  // Calculate how much wallet can be used (only for 2nd+ orders)
  const walletCalc = cashbackService.calculateWalletUsage({
    productPrice: subtotal,
    totalTax,
    walletBalance,
    isFirstOrder,
  });

  // Final amount customer pays after wallet deduction
  const finalPayable = parseFloat(
    (subtotal - walletCalc.maxUsable).toFixed(2)
  );

  res.json({
    isFirstOrder,
    order: {
      subtotal,
      totalTax,
      priceExclGst: parseFloat((subtotal - totalTax).toFixed(2)),
      cashbackEarned: orderCalc.cashbackAmount,
      breakdown: orderCalc.breakdown,
    },
    wallet: {
      currentBalance: walletBalance,
      optionA: walletCalc.optionA,
      optionA_desc: `40% of product excl. GST`,
      optionB: walletCalc.optionB,
      optionB_desc: `33% of wallet balance (₹${walletBalance})`,
      maxUsable: walletCalc.maxUsable,
      recommended: walletCalc.recommended,
    },
    summary: {
      youPay: finalPayable,
      walletApplied: walletCalc.maxUsable,
      cashbackYouEarn: orderCalc.cashbackAmount,
      cashbackValidDays: 30,
    },
  });
});

// ── POST /api/wallet/:customerId/redeem ───────────────────────────────────────
// Called after checkout to apply wallet credit.
// In production, call this BEFORE creating the Shopify discount code,
// or from a Shopify Function that validates the wallet server-side.
const redeemSchema = z.object({
  orderId: z.string(),
  orderName: z.string(),
  amountToUse: z.number().positive(),
});

router.post("/:customerId/redeem", async (req, res) => {
  const { shopId } = req;
  const { customerId } = req.params;
  const parsed = redeemSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const result = await cashbackService.redeemCashback({
    shopId,
    customerId: decodeURIComponent(customerId),
    ...parsed.data,
  });

  res.json(result);
});

module.exports = router;
