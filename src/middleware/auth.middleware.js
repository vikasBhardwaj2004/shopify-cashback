const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function validateShopSession(req, res, next) {
  const shopDomain =
    req.headers["x-shopify-shop-domain"] ||
    req.query.shop;

  if (!shopDomain) {
    return res.status(401).json({ error: "Missing shop domain" });
  }

  // Auto-register shop if not exists (for direct API usage without OAuth)
  let shop = await prisma.shop.findUnique({
    where: { domain: shopDomain },
    select: { id: true, isActive: true },
  });

  if (!shop) {
    // Create shop record automatically
    shop = await prisma.shop.create({
      data: {
        domain: shopDomain,
        accessToken: process.env.SHOPIFY_ACCESS_TOKEN || "pending",
        isActive: true,
      },
      select: { id: true, isActive: true },
    });

    // Create default settings for this shop
    await prisma.cashbackSettings.create({
      data: { shopId: shop.id }
    }).catch(() => {});
  }

  if (!shop.isActive) {
    return res.status(401).json({ error: "Shop inactive" });
  }

  req.shopId = shop.id;
  req.shopDomain = shopDomain;
  next();
}

module.exports = { validateShopSession };
