// src/services/cashback.service.js
// ─────────────────────────────────────────────────────────────────────────────
// All cashback business logic lives here:
//  - calculateOrderCashback()  → what cashback will be earned
//  - calculateWalletUsage()    → how much wallet can be applied
//  - awardCashback()           → write earned cashback to DB
//  - redeemCashback()          → deduct from wallet batches (FIFO)
//  - getWalletBalance()        → sum of non-expired active batches
//  - getWalletSummary()        → full wallet + batches + transactions
// ─────────────────────────────────────────────────────────────────────────────

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const logger = require("../utils/logger");
const { generateBatchRef } = require("../utils/helpers");

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Get shop settings, falling back to defaults if not configured.
 */
async function getSettings(shopId) {
  const settings = await prisma.cashbackSettings.findUnique({ where: { shopId } });
  if (settings) return settings;
  return {
    firstOrderExtraDisc: 10,
    firstOrderCashbackPct: 100,
    repeatCashbackPct: 100,
    maxWalletUsagePctOfProduct: 40,
    maxWalletUsagePctOfBalance: 33,
    cashbackValidDays: 30,
    minOrderValue: 299,
  };
}

/**
 * Get or create wallet for a customer.
 */
async function getOrCreateWallet(shopId, customerId, customerEmail) {
  return prisma.wallet.upsert({
    where: { shopId_customerId: { shopId, customerId } },
    update: {},
    create: { shopId, customerId, customerEmail },
  });
}

/**
 * Sum of all ACTIVE batch remaining amounts for a wallet.
 * Only counts non-expired batches.
 */
async function getWalletBalance(walletId) {
  const batches = await prisma.cashbackBatch.findMany({
    where: {
      walletId,
      status: { in: ["ACTIVE", "PARTIALLY_USED"] },
      expiresAt: { gt: new Date() },
    },
  });
  return batches.reduce((sum, b) => sum + (b.originalAmount - b.usedAmount - b.expiredAmount), 0);
}

// ── Core Calculation Functions ────────────────────────────────────────────────

/**
 * Calculate cashback for an order.
 *
 * Rules:
 *  - No cashback if subtotal < ₹299
 *  - No 30% discount here — Shopify handles discounts
 *  - First order: 10% extra discount applied, then cashback on discounted price (GST included)
 *  - Repeat orders: cashback directly on subtotal (GST included)
 *  - GST is NOT deducted — cashback is calculated on the full price including GST
 *
 * @param {object} params
 * @param {number}  params.subtotal      - Order subtotal from Shopify (tax-inclusive)
 * @param {number}  params.totalTax      - Actual GST amount from Shopify webhook
 * @param {boolean} params.isFirstOrder  - Whether this is the customer's first order
 * @returns {object} breakdown
 */
function calculateOrderCashback({ subtotal, totalTax, isFirstOrder }) {
  const MIN_ORDER_VALUE = 299;
  const FIRST_ORDER_EXTRA_DISC = 10; // %
  const CASHBACK_PCT = 100;          // % of discounted price (GST included)

  // Rule: minimum order value
  if (subtotal < MIN_ORDER_VALUE) {
    return {
      subtotal,
      totalTax,
      reason: `Order below ₹${MIN_ORDER_VALUE} — no cashback`,
      cashbackAmount: 0,
      isFirstOrder,
    };
  }

  // Step 1: Apply first-order 10% extra discount (on tax-inclusive subtotal)
  let discountedPrice = subtotal;
  let firstOrderDiscountAmt = 0;

  if (isFirstOrder) {
    firstOrderDiscountAmt = parseFloat((subtotal * (FIRST_ORDER_EXTRA_DISC / 100)).toFixed(2));
    discountedPrice = parseFloat((subtotal - firstOrderDiscountAmt).toFixed(2));
  }

  // Step 2: Cashback = 100% of discountedPrice (GST included — not deducted)
  const cashbackAmount = parseFloat((discountedPrice * (CASHBACK_PCT / 100)).toFixed(2));

  return {
    subtotal,
    totalTax,
    firstOrderDiscount: firstOrderDiscountAmt,
    discountedPrice,
    cashbackPct: CASHBACK_PCT,
    cashbackAmount: Math.max(0, cashbackAmount),
    isFirstOrder,
  };
}

/**
 * Calculate how much wallet credit can be applied to an order.
 *
 * Rules (for 2nd+ orders only):
 *  - Option A: 40% of product value excl. GST
 *  - Option B: 33% of current wallet balance
 *  - Customer gets the HIGHER of the two options
 *  - Cannot exceed actual wallet balance
 *  - First order: wallet cannot be used
 *
 * @param {object} params
 * @param {number}  params.productPrice   - Product subtotal (tax-inclusive)
 * @param {number}  params.totalTax       - Actual GST from Shopify
 * @param {number}  params.walletBalance  - Customer's current wallet balance
 * @param {boolean} params.isFirstOrder
 * @returns {object}
 */
function calculateWalletUsage({ productPrice, totalTax, walletBalance, isFirstOrder }) {
  if (isFirstOrder) {
    return {
      walletUsable: 0,
      optionA: 0,
      optionB: 0,
      reason: "Wallet cannot be used on first order",
    };
  }

  const productExclGst = parseFloat((productPrice - totalTax).toFixed(2));

  const optionA = parseFloat((productExclGst * 0.40).toFixed(2)); // 40% of product excl. GST
  const optionB = parseFloat((walletBalance  * 0.33).toFixed(2)); // 33% of wallet balance

  // Customer gets the HIGHER option, capped at actual balance
  const maxUsable = parseFloat(Math.min(Math.max(optionA, optionB), walletBalance).toFixed(2));

  return {
    walletUsable: maxUsable,
    walletBalance: parseFloat(walletBalance.toFixed(2)),
    optionA,
    optionB,
    optionA_desc: `40% of ₹${productExclGst} (product excl. GST)`,
    optionB_desc: `33% of ₹${walletBalance} (wallet balance)`,
    limitingFactor: optionA >= optionB ? "product_value_limit" : "balance_limit",
    recommended: optionA >= optionB ? "A" : "B",
  };
}

// ── DB Write Functions ────────────────────────────────────────────────────────

/**
 * Award cashback to a customer's wallet after order is paid.
 * Creates a new CashbackBatch and a EARN transaction.
 */
async function awardCashback({ shopId, customerId, customerEmail, orderId, orderName, orderType, cashbackAmount, cashbackValidDays }) {
  return prisma.$transaction(async (tx) => {
    const wallet = await getOrCreateWallet(shopId, customerId, customerEmail);
    const currentBalance = await getWalletBalance(wallet.id);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + cashbackValidDays);

    const batch = await tx.cashbackBatch.create({
      data: {
        batchRef: generateBatchRef(),
        walletId: wallet.id,
        orderId,
        orderName,
        orderType,
        originalAmount: cashbackAmount,
        expiresAt,
        status: "ACTIVE",
      },
    });

    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        batchId: batch.id,
        type: "EARN",
        amount: cashbackAmount,
        balanceBefore: currentBalance,
        balanceAfter: currentBalance + cashbackAmount,
        orderId,
        orderName,
        note: `Cashback earned from order ${orderName}`,
      },
    });

    await tx.wallet.update({
      where: { id: wallet.id },
      data: { totalEarned: { increment: cashbackAmount } },
    });

    logger.info(`Cashback awarded: ${cashbackAmount} to wallet ${wallet.id} (batch ${batch.batchRef})`);
    return { wallet, batch };
  });
}

/**
 * Redeem cashback from wallet — deducts from oldest batches first (FIFO).
 * Creates a USE transaction per batch touched.
 */
async function redeemCashback({ shopId, customerId, orderId, orderName, amountToUse }) {
  return prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({
      where: { shopId_customerId: { shopId, customerId } },
    });
    if (!wallet) throw Object.assign(new Error("Wallet not found"), { status: 404 });

    const currentBalance = await getWalletBalance(wallet.id);
    if (amountToUse > currentBalance) {
      throw Object.assign(
        new Error(`Insufficient balance. Available: ${currentBalance}, Requested: ${amountToUse}`),
        { status: 400 }
      );
    }

    const batches = await tx.cashbackBatch.findMany({
      where: {
        walletId: wallet.id,
        status: { in: ["ACTIVE", "PARTIALLY_USED"] },
        expiresAt: { gt: new Date() },
      },
      orderBy: { expiresAt: "asc" },
    });

    let remaining = amountToUse;

    for (const batch of batches) {
      if (remaining <= 0) break;

      const available = batch.originalAmount - batch.usedAmount - batch.expiredAmount;
      const deduct = Math.min(available, remaining);

      const newUsed = batch.usedAmount + deduct;
      const fullyUsed = newUsed >= batch.originalAmount - batch.expiredAmount - 0.001;

      await tx.cashbackBatch.update({
        where: { id: batch.id },
        data: {
          usedAmount: newUsed,
          status: fullyUsed ? "FULLY_USED" : "PARTIALLY_USED",
        },
      });

      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          batchId: batch.id,
          type: "USE",
          amount: deduct,
          balanceBefore: currentBalance,
          balanceAfter: currentBalance - amountToUse,
          orderId,
          orderName,
          note: `Used from batch ${batch.batchRef} for order ${orderName}`,
        },
      });

      remaining -= deduct;
    }

    await tx.wallet.update({
      where: { id: wallet.id },
      data: { totalUsed: { increment: amountToUse } },
    });

    logger.info(`Cashback redeemed: ${amountToUse} from wallet ${wallet.id}`);
    return { amountUsed: amountToUse, newBalance: currentBalance - amountToUse };
  });
}

// ── Query Functions ───────────────────────────────────────────────────────────

async function getWalletSummary({ shopId, customerId }) {
  const wallet = await prisma.wallet.findUnique({
    where: { shopId_customerId: { shopId, customerId } },
    include: {
      batches: { orderBy: { earnedAt: "desc" }, take: 50 },
      transactions: { orderBy: { createdAt: "desc" }, take: 50 },
    },
  });

  if (!wallet) {
    return { exists: false, balance: 0, batches: [], transactions: [] };
  }

  const now = new Date();
  const activeBatches = wallet.batches.filter(
    (b) => ["ACTIVE", "PARTIALLY_USED"].includes(b.status) && b.expiresAt > now
  );

  const balance = activeBatches.reduce(
    (sum, b) => sum + (b.originalAmount - b.usedAmount - b.expiredAmount),
    0
  );

  return {
    exists: true,
    walletId: wallet.id,
    balance: parseFloat(balance.toFixed(2)),
    totalEarned: wallet.totalEarned,
    totalUsed: wallet.totalUsed,
    totalExpired: wallet.totalExpired,
    activeBatches: activeBatches.map((b) => ({
      id: b.id,
      batchRef: b.batchRef,
      orderName: b.orderName,
      orderType: b.orderType,
      originalAmount: b.originalAmount,
      remaining: parseFloat((b.originalAmount - b.usedAmount - b.expiredAmount).toFixed(2)),
      earnedAt: b.earnedAt,
      expiresAt: b.expiresAt,
      daysLeft: Math.max(0, Math.ceil((b.expiresAt - now) / (1000 * 60 * 60 * 24))),
      status: b.status,
    })),
    transactions: wallet.transactions.map((t) => ({
      id: t.id,
      type: t.type,
      amount: t.amount,
      balanceBefore: t.balanceBefore,
      balanceAfter: t.balanceAfter,
      orderName: t.orderName,
      note: t.note,
      createdAt: t.createdAt,
    })),
  };
}

async function isFirstOrder({ shopId, customerId }) {
  const wallet = await prisma.wallet.findUnique({
    where: { shopId_customerId: { shopId, customerId } },
    include: { batches: { take: 1 } },
  });
  return !wallet || wallet.batches.length === 0;
}

module.exports = {
  getSettings,
  getOrCreateWallet,
  getWalletBalance,
  calculateOrderCashback,
  calculateWalletUsage,
  awardCashback,
  redeemCashback,
  getWalletSummary,
  isFirstOrder,
};
