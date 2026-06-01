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

  const settings = await cashbackService.getSettings(shopId);

  // Determine if this is the customer's first order
  const firstOrder = await cashbackService.isFirstOrder({ shopId, customerId });

  // Calculate MRP total from line items (compare_at_price = MRP)
  // Falls back to line_item price if no compare_at_price set
  let mrpTotal = 0;
  let priceBeforeGst = 0;

  for (const item of order.line_items || []) {
    const mrpUnit = parseFloat(item.compare_at_price || item.price) || 0;
    mrpTotal += mrpUnit * item.quantity;
    priceBeforeGst += parseFloat(item.price) * item.quantity;
  }

  // Derive GST from tax lines
  const totalTax = order.tax_lines?.reduce((s, t) => s + parseFloat(t.price), 0) || 0;
  const priceWithoutGst = parseFloat(order.subtotal_price) - 0; // subtotal already excludes tax
  const gstRate = priceWithoutGst > 0 ? totalTax / priceWithoutGst : settings.defaultGstRate / 100;

  // Calculate cashback amount (based on price before GST)
  const breakdown = cashbackService.calculateOrderCashback({
    mrpTotal: priceWithoutGst, // Use actual paid subtotal as base for cashback
    gstRate,
    isFirstOrder: firstOrder,
    settings,
  });

  logger.info(`Order ${orderName} cashback breakdown`, {
    customerId,
    firstOrder,
    cashbackAmount: breakdown.cashbackAmount,
    breakdown,
  });

  // Award cashback
  const { wallet, batch } = await cashbackService.awardCashback({
    shopId,
    customerId,
    customerEmail,
    orderId,
    orderName,
    orderType: firstOrder ? "FIRST" : "REPEAT",
    cashbackAmount: breakdown.cashbackAmount,
    cashbackValidDays: settings.cashbackValidDays,
  });

  logger.info(
    `Cashback batch ${batch.batchRef} created: ₹${breakdown.cashbackAmount} for ${customerEmail} (expires ${batch.expiresAt.toISOString()})`
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
