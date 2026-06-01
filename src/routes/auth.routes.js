// src/routes/auth.routes.js
// Handles Shopify OAuth install & callback
const express = require("express");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

module.exports = function authRoutes(shopify) {
  const router = express.Router();

  // Step 1: Redirect to Shopify OAuth
  router.get("/", async (req, res) => {
    await shopify.auth.begin({
      shop: shopify.utils.sanitizeShop(req.query.shop, true),
      callbackPath: "/auth/callback",
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });
  });

  // Step 2: OAuth callback — save access token
  router.get("/callback", async (req, res) => {
    try {
      const callback = await shopify.auth.callback({
        rawRequest: req,
        rawResponse: res,
      });

      const { session } = callback;

      // Persist shop + access token
      await prisma.shop.upsert({
        where: { domain: session.shop },
        update: { accessToken: session.accessToken, isActive: true },
        create: { domain: session.shop, accessToken: session.accessToken },
      });

      // Register webhooks
      await registerWebhooks(shopify, session);

      res.redirect(`/?shop=${session.shop}&host=${req.query.host}`);
    } catch (err) {
      console.error("Auth callback error:", err);
      res.status(500).send("Authentication failed");
    }
  });

  return router;
};

async function registerWebhooks(shopify, session) {
  const webhooks = [
    { topic: "ORDERS_PAID", address: `${process.env.HOST}/api/webhooks/orders/paid` },
    { topic: "REFUNDS_CREATE", address: `${process.env.HOST}/api/webhooks/orders/refunded` },
  ];

  for (const wh of webhooks) {
    try {
      const client = new shopify.clients.Graphql({ session });
      await client.query({
        data: {
          query: `
            mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
              webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
                webhookSubscription { id }
                userErrors { field message }
              }
            }
          `,
          variables: {
            topic: wh.topic,
            webhookSubscription: {
              callbackUrl: wh.address,
              format: "JSON",
            },
          },
        },
      });
      console.log(`Webhook registered: ${wh.topic}`);
    } catch (err) {
      console.error(`Failed to register webhook ${wh.topic}:`, err.message);
    }
  }
}
