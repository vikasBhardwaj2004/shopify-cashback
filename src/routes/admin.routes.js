// src/routes/admin.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Admin-only routes for the Shopify merchant dashboard.
//
// GET  /api/admin/settings              → get cashback settings
// PUT  /api/admin/settings              → update cashback settings
// GET  /api/admin/wallets               → list all customer wallets
// GET  /api/admin/wallets/:customerId   → single customer wallet (admin view)
// POST /api/admin/wallets/:customerId/adjust → manually credit/debit wallet
// POST /api/admin/expire-now            → manually trigger expiry job
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const router = express.Router();
const { z } = require("zod");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const cashbackService = require("../services/cashback.service");
const { runExpiryJob } = require("../jobs/expiry.job");
const { validateShopSession } = require("../middleware/auth.middleware");
const logger = require("../utils/logger");

router.use(validateShopSession);

// ── GET /api/admin/settings ───────────────────────────────────────────────────
router.get("/settings", async (req, res) => {
  const settings = await cashbackService.getSettings(req.shopId);
  res.json(settings);
});

// ── PUT /api/admin/settings ───────────────────────────────────────────────────
const settingsSchema = z.object({
  mrpDiscountPercent: z.number().min(0).max(100).optional(),
  firstOrderExtraDisc: z.number().min(0).max(100).optional(),
  firstOrderCashbackPct: z.number().min(0).max(100).optional(),
  repeatCashbackPct: z.number().min(0).max(100).optional(),
  maxWalletUsagePctOfProduct: z.number().min(0).max(100).optional(),
  maxWalletUsagePctOfBalance: z.number().min(0).max(100).optional(),
  cashbackValidDays: z.number().int().min(1).max(365).optional(),
  defaultGstRate: z.number().min(0).max(100).optional(),
});

router.put("/settings", async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const updated = await prisma.cashbackSettings.upsert({
    where: { shopId: req.shopId },
    update: parsed.data,
    create: { shopId: req.shopId, ...parsed.data },
  });

  res.json(updated);
});

// ── GET /api/admin/wallets ────────────────────────────────────────────────────
router.get("/wallets", async (req, res) => {
  const { page = 1, limit = 20, search } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const where = {
    shopId: req.shopId,
    ...(search && {
      OR: [
        { customerEmail: { contains: search, mode: "insensitive" } },
        { customerId: { contains: search } },
      ],
    }),
  };

  const [wallets, total] = await Promise.all([
    prisma.wallet.findMany({
      where,
      skip,
      take: parseInt(limit),
      orderBy: { updatedAt: "desc" },
      include: {
        batches: {
          where: {
            status: { in: ["ACTIVE", "PARTIALLY_USED"] },
            expiresAt: { gt: new Date() },
          },
        },
      },
    }),
    prisma.wallet.count({ where }),
  ]);

  const walletsWithBalance = wallets.map((w) => ({
    ...w,
    balance: w.batches.reduce(
      (sum, b) => sum + (b.originalAmount - b.usedAmount - b.expiredAmount),
      0
    ),
    batches: undefined,
  }));

  res.json({ wallets: walletsWithBalance, total, page: parseInt(page), limit: parseInt(limit) });
});

// ── GET /api/admin/wallets/:customerId ────────────────────────────────────────
router.get("/wallets/:customerId", async (req, res) => {
  const summary = await cashbackService.getWalletSummary({
    shopId: req.shopId,
    customerId: decodeURIComponent(req.params.customerId),
  });
  res.json(summary);
});

// ── POST /api/admin/wallets/:customerId/adjust ────────────────────────────────
// Manually credit or debit a customer's wallet (e.g., for support reasons)
const adjustSchema = z.object({
  amount: z.number().positive(),
  type: z.enum(["CREDIT", "DEBIT"]),
  note: z.string().min(1),
  customerEmail: z.string().email().optional(),
});

router.post("/wallets/:customerId/adjust", async (req, res) => {
  const parsed = adjustSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { amount, type, note, customerEmail } = parsed.data;
  const customerId = decodeURIComponent(req.params.customerId);

  if (type === "CREDIT") {
    const settings = await cashbackService.getSettings(req.shopId);
    const result = await cashbackService.awardCashback({
      shopId: req.shopId,
      customerId,
      customerEmail: customerEmail || "manual-adjustment@shop.com",
      orderId: "manual-adjustment",
      orderName: "Manual Adjustment",
      orderType: "REPEAT",
      cashbackAmount: amount,
      cashbackValidDays: settings.cashbackValidDays,
    });
    return res.json({ success: true, batch: result.batch, note });
  }

  if (type === "DEBIT") {
    const wallet = await prisma.wallet.findUnique({
      where: { shopId_customerId: { shopId: req.shopId, customerId } },
    });
    if (!wallet) return res.status(404).json({ error: "Wallet not found" });

    const balance = await cashbackService.getWalletBalance(wallet.id);
    if (amount > balance) {
      return res.status(400).json({ error: `Insufficient balance. Available: ₹${balance}` });
    }

    const result = await cashbackService.redeemCashback({
      shopId: req.shopId,
      customerId,
      orderId: "manual-adjustment",
      orderName: "Manual Debit",
      amountToUse: amount,
    });
    return res.json({ success: true, ...result, note });
  }
});

// ── POST /api/admin/expire-now ────────────────────────────────────────────────
// Manually trigger the expiry job (useful for testing or emergency cleanup)
router.post("/expire-now", async (req, res) => {
  logger.info(`Manual expiry job triggered by shop ${req.shopId}`);
  res.json({ started: true });
  await runExpiryJob();
});

module.exports = router;
