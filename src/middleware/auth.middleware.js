// src/middleware/auth.middleware.js
// Validates that the request comes from a known installed shop.
// Attaches req.shopId for downstream route handlers.

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function validateShopSession(req, res, next) {
  // Accept shop domain from header (storefront) or query param (admin)
  const shopDomain =
    req.headers["x-shopify-shop-domain"] ||
    req.query.shop;

  if (!shopDomain) {
    return res.status(401).json({ error: "Missing shop domain" });
  }

  const shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true, isActive: true },
  });

  if (!shop || !shop.isActive) {
    return res.status(401).json({ error: "Shop not found or inactive" });
  }

  req.shopId = shop.id;
  req.shopDomain = shopDomain;
  next();
}

module.exports = { validateShopSession };
