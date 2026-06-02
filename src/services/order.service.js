// src/services/order.service.js
// ─────────────────────────────────────────────────────────────────────────────
// Handles the full order lifecycle:
//   handleOrderPaid()  → called by orders/paid webhook
//                         - checks first-order status
//                         - awards cashback
//   handleOrderRefund() → partial cashback reversal on refund
// ─────────────────────────────────────────────────────────────────────────────

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const cashbackService = require("./cashback.service");
const logger = require("../utils/logger");

/**
 * Called when an order is marked as PAID in Shopify.
 * Awards cashback to the customer's wallet.
 *
 * @param {object} params
 * @param {string} params.shopId     - Internal shop ID
 * @param {string} params.shopDomain - e.g. mystore.myshopify.com
 * @param {object} params.order      - Raw Shopify order webhook payload
 */
async function handleOrderPaid({ shopId, shopDomain, order }) {
  const customerId = `gid://shopify/Customer/${order.customer?.id}`;
  const customerEmail = order.customer?.email || order.email;
  const orderId = `gid://shopify/Order/${order.id}`;
  const orderName = order.name; // e.g. #1043

  if (!order.customer?.id) {
    logger.warn(`Order ${orderName} has no customer — skipping cashback`);
    return;
  }

  // Determine if this is the customer's first order
  const firstOrder = await cashbackService.isFirstOrder({ shopId, customerId });

  // ── Extract financial data from Shopify webhook ───────────────────────────
  // subtotal_price = product total (tax-inclusive), Shopify sends as string
  // total_tax      = actual GST charged by Shopify, also a string
  // const subtotal = parseFloat(order.subtotal_price || "0");
  // const totalTax = parseFloat(order.total_tax || "0");

  // logger.info(`Order ${orderName} | subtotal: ₹${subtotal} | tax: ₹${totalTax} | firstOrder: ${firstOrder}`);


const subtotal = parseFloat(order.subtotal_price || "0");
const totalTax = parseFloat(order.total_tax || "0");

logger.info(`Order ${orderName} | subtotal: ₹${subtotal} | tax: ₹${totalTax} | firstOrder: ${firstOrder}`);

// DEBUG: Check actual tax data coming from Shopify
logger.info("ORDER TAX DEBUG", {
  orderId: order.id,
  orderName: order.name,
  subtotal_price: order.subtotal_price,
  total_tax: order.total_tax,
  taxes_included: order.taxes_included,
  tax_lines: order.tax_lines,
  line_items: order.line_items,
});
  
  // ── Calculate cashback ────────────────────────────────────────────────────
  const { cashbackAmount, breakdown } = cashbackService.calculateOrderCashback({
    subtotal,
    totalTax,
    isFirstOrder: firstOrder,
  });

  logger.info(`Order ${orderName} cashback breakdown`, {
    customerId,
    firstOrder,
    cashbackAmount,
    breakdown,
  });

  if (cashbackAmount <= 0) {
    logger.info(`No cashback for order ${orderName} — ${breakdown.reason || "amount is 0"}`);
    return;
  }

  // ── Award cashback ────────────────────────────────────────────────────────
  const settings = await cashbackService.getSettings(shopId);

  const { wallet, batch } = await cashbackService.awardCashback({
    shopId,
    customerId,
    customerEmail,
    orderId,
    orderName,
    orderType: firstOrder ? "FIRST" : "REPEAT",
    cashbackAmount,
    cashbackValidDays: settings.cashbackValidDays,
  });

  logger.info(
    `Cashback batch ${batch.batchRef} created: ₹${cashbackAmount} for ${customerEmail} (expires ${batch.expiresAt.toISOString()})`
  );

  return { wallet, batch, breakdown };
}

/**
 * Called when an order is refunded.
 * Attempts to reverse cashback earned on that order.
 * Only reverses if the cashback batch still has unused balance.
 */
async function handleOrderRefund({ shopId, order, refundAmount }) {
  const customerId = `gid://shopify/Customer/${order.customer?.id}`;
  if (!customerId) return;

  const wallet = await prisma.wallet.findUnique({
    where: { shopId_customerId: { shopId, customerId } },
    include: {
      batches: {
        where: { orderId: `gid://shopify/Order/${order.id}` },
      },
    },
  });

  if (!wallet || wallet.batches.length === 0) return;

  const batch = wallet.batches[0];
  const refundable = batch.originalAmount - batch.usedAmount - batch.expiredAmount;
  const toReverse = Math.min(refundable, refundAmount);

  if (toReverse <= 0) {
    logger.info(`No reversible cashback for order ${order.name}`);
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.cashbackBatch.update({
      where: { id: batch.id },
      data: {
        expiredAmount: { increment: toReverse },
        status: toReverse >= refundable ? "FULLY_USED" : "PARTIALLY_USED",
      },
    });

    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        batchId: batch.id,
        type: "EXPIRE",
        amount: toReverse,
        balanceBefore: refundable,
        balanceAfter: refundable - toReverse,
        orderId: `gid://shopify/Order/${order.id}`,
        orderName: order.name,
        note: `Cashback reversed due to refund on order ${order.name}`,
      },
    });

    await tx.wallet.update({
      where: { id: wallet.id },
      data: { totalExpired: { increment: toReverse } },
    });
  });

  logger.info(`Reversed ₹${toReverse} cashback for order ${order.name}`);
}

module.exports = { handleOrderPaid, handleOrderRefund };
