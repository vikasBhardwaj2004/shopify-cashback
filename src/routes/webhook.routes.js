// src/routes/webhook.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Shopify webhook endpoints. All incoming requests are HMAC-verified.
// Register these in your Shopify Partner Dashboard or via API:
//   - orders/paid     → POST /api/webhooks/orders/paid
//   - orders/refunds/create → POST /api/webhooks/orders/refunded
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const orderService = require("../services/order.service");
const logger = require("../utils/logger");

// ── HMAC Verification Middleware ──────────────────────────────────────────────
function verifyShopifyWebhook(req, res, next) {
  const hmac = req.headers["x-shopify-hmac-sha256"];
  const shop = req.headers["x-shopify-shop-domain"];

  if (!hmac || !shop) {
    return res.status(401).json({ error: "Missing webhook headers" });
  }

  const digest = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET)
    .update(req.body) // raw body buffer
    .digest("base64");

  if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac))) {
    logger.warn(`Invalid webhook HMAC from ${shop}`);
    return res.status(401).json({ error: "Invalid HMAC" });
  }

  // Attach parsed body and shop domain for downstream handlers
  req.shopDomain = shop;
  req.webhookBody = JSON.parse(req.body.toString());
  next();
}

// ── Helper: resolve shopId from domain ───────────────────────────────────────
async function getShopId(domain) {
  const shop = await prisma.shop.findUnique({ where: { domain } });
  return shop?.id || null;
}

// ── orders/paid ───────────────────────────────────────────────────────────────
router.post("/orders/paid", verifyShopifyWebhook, async (req, res) => {
  const order = req.webhookBody;
  const shopId = await getShopId(req.shopDomain);

  if (!shopId) {
    logger.warn(`Webhook received for unknown shop: ${req.shopDomain}`);
    return res.status(200).json({ skipped: true }); // Always 200 to Shopify
  }

  // Respond immediately — process async
  res.status(200).json({ received: true });

  try {
    await orderService.handleOrderPaid({
      shopId,
      shopDomain: req.shopDomain,
      order,
    });
  } catch (err) {
    logger.error("Error processing orders/paid webhook", {
      error: err.message,
      orderId: order.id,
    });
  }
});

// ── orders/refunds/create ─────────────────────────────────────────────────────
router.post("/orders/refunded", verifyShopifyWebhook, async (req, res) => {
  const payload = req.webhookBody; // This is a Refund object
  const shopId = await getShopId(req.shopDomain);

  if (!shopId) return res.status(200).json({ skipped: true });

  res.status(200).json({ received: true });

  try {
    // Fetch associated order (refund payload contains order_id)
    const refundAmount = payload.transactions
      ?.filter((t) => t.kind === "refund")
      .reduce((sum, t) => sum + parseFloat(t.amount), 0) || 0;

    await orderService.handleOrderRefund({
      shopId,
      order: { id: payload.order_id, name: `#${payload.order_id}`, customer: payload.customer },
      refundAmount,
    });
  } catch (err) {
    logger.error("Error processing refund webhook", { error: err.message });
  }
});

module.exports = router;
