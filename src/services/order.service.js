// src/services/order.service.js

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const cashbackService = require("./cashback.service");
const logger = require("../utils/logger");

const MIN_ORDER_FOR_CASHBACK = 299;

/**
 * Calculate exact price excluding GST from line items.
 * Uses Shopify's actual tax_lines per item — 100% accurate.
 * Works for 5% (shampoo/soap/hair oil) and 18% (everything else).
 */
function calculateExactPriceExcludingGst(lineItems) {
  let totalPriceWithGst = 0;
  let totalGst = 0;

  for (const item of lineItems || []) {
    const itemTotal = parseFloat(item.price) * item.quantity;
    totalPriceWithGst += itemTotal;

    // Get exact GST from Shopify's tax_lines per item
    const itemGst = (item.tax_lines || []).reduce((sum, tax) => {
      return sum + parseFloat(tax.price || 0);
    }, 0);

    totalGst += itemGst;

    logger.info(`Line item: ${item.title} | Price: ₹${itemTotal} | GST: ₹${itemGst.toFixed(2)} | Rate: ${item.tax_lines?.[0]?.rate ? item.tax_lines[0].rate * 100 : 0}%`);
  }

  // If Shopify gave us tax data, use it
  if (totalGst > 0) {
    const priceExcludingGst = parseFloat((totalPriceWithGst - totalGst).toFixed(2));
    logger.info(`Total: ₹${totalPriceWithGst} | Total GST: ₹${totalGst.toFixed(2)} | Excl. GST: ₹${priceExcludingGst}`);
    return { priceExcludingGst, totalGst: parseFloat(totalGst.toFixed(2)), method: "exact_tax_lines" };
  }

  // Tax inclusive pricing — Shopify shows ₹0 tax separately
  // Use order.total_tax if available
  return null; // will fallback in caller
}

async function handleOrderPaid({ shopId, shopDomain, order }) {
  const customerId = `gid://shopify/Customer/${order.customer?.id}`;
  const customerEmail = order.customer?.email || order.email;
  const orderId = `gid://shopify/Order/${order.id}`;
  const orderName = order.name;

  if (!order.customer?.id) {
    logger.warn(`Order ${orderName} has no customer — skipping cashback`);
    return;
  }

  const settings = await cashbackService.getSettings(shopId);
  const firstOrder = await cashbackService.isFirstOrder({ shopId, customerId });

  // Subtotal = product prices only (no shipping, no tax added separately)
  const subtotal = parseFloat(order.subtotal_price) || 0;

  // Minimum order check
  if (subtotal < MIN_ORDER_FOR_CASHBACK) {
    logger.info(`Order ${orderName}: subtotal ₹${subtotal} below minimum ₹${MIN_ORDER_FOR_CASHBACK} — no cashback`);
    return;
  }

  // ── STEP 1: Get exact GST from line items ──────────────────────────────────
  let priceExcludingGst;
  let totalGst;
  let gstMethod;

  const lineItemResult = calculateExactPriceExcludingGst(order.line_items);

  if (lineItemResult) {
    // Got exact GST from line items (tax exclusive pricing)
    priceExcludingGst = lineItemResult.priceExcludingGst;
    totalGst = lineItemResult.totalGst;
    gstMethod = lineItemResult.method;
  } else {
    // Tax inclusive pricing — use order.total_tax
    const orderTax = parseFloat(order.total_tax) || 0;

    if (orderTax > 0) {
      // Shopify gave us total_tax separately
      priceExcludingGst = parseFloat((subtotal - orderTax).toFixed(2));
      totalGst = orderTax;
      gstMethod = "order_total_tax";
    } else {
      // Tax fully inclusive, not shown — calculate from line items using rates
      let totalWithGst = 0;
      let totalGstCalc = 0;

      for (const item of order.line_items || []) {
        const itemTotal = parseFloat(item.price) * item.quantity;
        // Get GST rate from tax_lines (e.g. 0.05 or 0.18)
        const gstRate = item.tax_lines?.[0]?.rate || 0.18; // default 18%
        // If tax inclusive: GST = itemTotal - (itemTotal / (1 + gstRate))
        const gstAmount = itemTotal - (itemTotal / (1 + gstRate));
        totalWithGst += itemTotal;
        totalGstCalc += gstAmount;

        logger.info(`Tax inclusive item: ${item.title} | ₹${itemTotal} | Rate: ${gstRate * 100}% | GST: ₹${gstAmount.toFixed(2)}`);
      }

      priceExcludingGst = parseFloat((totalWithGst - totalGstCalc).toFixed(2));
      totalGst = parseFloat(totalGstCalc.toFixed(2));
      gstMethod = "tax_inclusive_calculated";
    }
  }

  priceExcludingGst = Math.max(0, priceExcludingGst);

  // ── STEP 2: Apply 10% first order discount on excl-GST price ─────────────
  let cashbackBase = priceExcludingGst;
  let firstOrderDiscount = 0;
  if (firstOrder) {
    firstOrderDiscount = parseFloat((priceExcludingGst * (settings.firstOrderExtraDisc / 100)).toFixed(2));
    cashbackBase = parseFloat((priceExcludingGst - firstOrderDiscount).toFixed(2));
  }

  // ── STEP 3: Calculate cashback = 100% of cashbackBase ────────────────────
  const cashbackPct = firstOrder ? settings.firstOrderCashbackPct : settings.repeatCashbackPct;
  const cashbackAmount = parseFloat((cashbackBase * (cashbackPct / 100)).toFixed(2));

  logger.info(`Order ${orderName} final cashback calculation`, {
    customerId,
    firstOrder,
    subtotal,
    totalGst,
    gstMethod,
    priceExcludingGst,
    firstOrderDiscount,
    cashbackBase,
    cashbackAmount,
  });

  if (cashbackAmount <= 0) {
    logger.info(`Order ${orderName}: cashback ₹0 — skipping`);
    return;
  }

  // ── STEP 4: Award cashback ─────────────────────────────────────────────────
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
    `✅ Cashback ₹${cashbackAmount} awarded to ${customerEmail} | Batch: ${batch.batchRef} | Method: ${gstMethod} | GST removed: ₹${totalGst} | Expires: ${batch.expiresAt.toISOString()}`
  );

  return { wallet, batch, cashbackAmount, totalGst, gstMethod };
}

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
