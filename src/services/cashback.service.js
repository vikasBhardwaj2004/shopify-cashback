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
  // Return hard-coded defaults if store hasn't customised yet
  return {
    mrpDiscountPercent: 30,
    firstOrderExtraDisc: 10,
    firstOrderCashbackPct: 100,
    repeatCashbackPct: 100,
    maxWalletUsagePctOfProduct: 40,
    maxWalletUsagePctOfBalance: 33,
    cashbackValidDays: 30,
    defaultGstRate: 18,
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
 * Calculate discounted price and cashback for an order.
 *
 * @param {object} params
 * @param {number} params.mrpTotal         - Total MRP (pre-any-discount)
 * @param {number} params.gstRate          - GST rate as decimal (e.g. 0.18)
 * @param {boolean} params.isFirstOrder    - Whether this is the customer's first order
 * @returns {object} breakdown
 */
function calculateOrderCashback({ mrpTotal, gstRate, isFirstOrder, settings }) {
  const s = settings;

  // Step 1: Apply 30% MRP discount
  const mrpDiscount = mrpTotal * (s.mrpDiscountPercent / 100);
  let discountedPrice = mrpTotal - mrpDiscount;

  // Step 2: Extra 10% for first order
  let firstOrderDiscount = 0;
  if (isFirstOrder) {
    firstOrderDiscount = discountedPrice * (s.firstOrderExtraDisc / 100);
    discountedPrice -= firstOrderDiscount;
  }

  // Step 3: Price before GST
  const priceBeforeGst = discountedPrice;

  // Step 4: GST on top
  const gstAmount = priceBeforeGst * gstRate;
  const finalPayable = priceBeforeGst + gstAmount;

  // Step 5: Cashback = % of price-before-GST
  const cashbackPct = isFirstOrder ? s.firstOrderCashbackPct : s.repeatCashbackPct;
  const cashbackAmount = parseFloat((priceBeforeGst * (cashbackPct / 100)).toFixed(2));

  return {
    mrpTotal,
    mrpDiscount: parseFloat(mrpDiscount.toFixed(2)),
    firstOrderDiscount: parseFloat(firstOrderDiscount.toFixed(2)),
    priceBeforeGst: parseFloat(priceBeforeGst.toFixed(2)),
    gstAmount: parseFloat(gstAmount.toFixed(2)),
    finalPayable: parseFloat(finalPayable.toFixed(2)),
    cashbackAmount,
    cashbackPct,
    isFirstOrder,
  };
}

/**
 * Calculate how much wallet credit can be applied to an order.
 *
 * Rules:
 *  - Max 40% of product value (price before GST)
 *  - Max 33% of current wallet balance
 *  - Cannot exceed actual wallet balance
 *
 * @returns {{ walletUsable: number, reason: string }}
 */
function calculateWalletUsage({ priceBeforeGst, walletBalance, settings }) {
  const s = settings;

  const maxByProduct = priceBeforeGst * (s.maxWalletUsagePctOfProduct / 100);
  const maxByBalance = walletBalance * (s.maxWalletUsagePctOfBalance / 100);
  const walletUsable = parseFloat(Math.min(maxByProduct, maxByBalance, walletBalance).toFixed(2));

  return {
    walletUsable,
    walletBalance: parseFloat(walletBalance.toFixed(2)),
    maxByProduct: parseFloat(maxByProduct.toFixed(2)),
    maxByBalance: parseFloat(maxByBalance.toFixed(2)),
    limitingFactor:
      maxByProduct <= maxByBalance ? "product_value_limit" : "balance_limit",
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

    // Get active batches sorted by expiry (oldest first — FIFO)
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

/**
 * Full wallet summary for customer-facing wallet page.
 */
async function getWalletSummary({ shopId, customerId }) {
  const wallet = await prisma.wallet.findUnique({
    where: { shopId_customerId: { shopId, customerId } },
    include: {
      batches: {
        orderBy: { earnedAt: "desc" },
        take: 50,
      },
      transactions: {
        orderBy: { createdAt: "desc" },
        take: 50,
      },
    },
  });

  if (!wallet) {
    return { exists: false, balance: 0, batches: [], transactions: [] };
  }

  const now = new Date();

  const activeBatches = wallet.batches.filter(
    (b) =>
      ["ACTIVE", "PARTIALLY_USED"].includes(b.status) && b.expiresAt > now
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

/**
 * Check if a customer has placed any previous orders on this shop.
 * Used to determine first-order status.
 */
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
