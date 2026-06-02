// src/services/order.service.js
// ─────────────────────────────────────────────────────────────────────────────
// Handles the full order lifecycle:
//   handleOrderPaid() → called by orders/paid webhook
//     - checks first-order status
//     - awards cashback using ACTUAL Shopify tax data
//     - records transaction in DB
// ─────────────────────────────────────────────────────────────────────────────

const db = require('../config/database');
const { calculateOrderCashback } = require('./cashback.service');

// ─────────────────────────────────────────────────────────────────────────────
// handleOrderPaid()
//
// Called from webhook when Shopify fires orders/paid event.
//
// @param {object} order   Full Shopify order object from webhook payload
// ─────────────────────────────────────────────────────────────────────────────
async function handleOrderPaid(order) {
  const customerId = String(order.customer?.id);
  const orderId    = String(order.id);
  const orderName  = order.name; // e.g. "#1215"

  if (!customerId) {
    console.log(`[order.service] Skipping order ${orderId} — no customer`);
    return;
  }

  // ── Prevent duplicate processing ──────────────────────────────────────────
  const existing = await db.query(
    'SELECT id FROM cashback_transactions WHERE order_id = $1',
    [orderId]
  );
  if (existing.rows.length > 0) {
    console.log(`[order.service] Order ${orderId} already processed — skip`);
    return;
  }

  // ── Is this the customer's first order? ───────────────────────────────────
  const prevOrders = await db.query(
    `SELECT id FROM cashback_transactions
     WHERE customer_id = $1 AND status = 'completed'
     ORDER BY created_at ASC`,
    [customerId]
  );
  const isFirstOrder = prevOrders.rows.length === 0;

  // ── Extract financial data from Shopify webhook ───────────────────────────
  // subtotal_price = product total (excl. shipping), tax-inclusive
  // total_tax      = actual GST charged by Shopify
  // Shopify sends these as strings — parse to float
  const subtotal = parseFloat(order.subtotal_price || '0');
  const totalTax = parseFloat(order.total_tax      || '0');

  console.log(`[order.service] Order ${orderName} | subtotal: ₹${subtotal} | tax: ₹${totalTax} | firstOrder: ${isFirstOrder}`);

  // ── Calculate cashback ────────────────────────────────────────────────────
  const { cashbackAmount, breakdown } = calculateOrderCashback({
    subtotal,
    totalTax,
    isFirstOrder,
  });

  console.log(`[order.service] Cashback for ${orderName}:`, breakdown);

  if (cashbackAmount <= 0) {
    console.log(`[order.service] No cashback for order ${orderName} — ${breakdown.reason || 'amount is 0'}`);
    return;
  }

  // ── Award cashback to wallet ───────────────────────────────────────────────
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30); // 30-day expiry

  await db.query('BEGIN');
  try {
    // 1. Insert cashback transaction record
    await db.query(
      `INSERT INTO cashback_transactions
         (customer_id, order_id, order_name, amount, status,
          is_first_order, subtotal, tax_amount, breakdown, expires_at)
       VALUES ($1,$2,$3,$4,'completed',$5,$6,$7,$8,$9)`,
      [
        customerId,
        orderId,
        orderName,
        cashbackAmount,
        isFirstOrder,
        subtotal,
        totalTax,
        JSON.stringify(breakdown),
        expiresAt,
      ]
    );

    // 2. Update or create wallet balance
    await db.query(
      `INSERT INTO wallets (customer_id, balance)
       VALUES ($1, $2)
       ON CONFLICT (customer_id)
       DO UPDATE SET balance = wallets.balance + $2, updated_at = NOW()`,
      [customerId, cashbackAmount]
    );

    await db.query('COMMIT');
    console.log(`[order.service] ✅ Cashback ₹${cashbackAmount} awarded to customer ${customerId}`);
  } catch (err) {
    await db.query('ROLLBACK');
    console.error(`[order.service] ❌ Failed to award cashback:`, err);
    throw err;
  }
}

module.exports = { handleOrderPaid };
