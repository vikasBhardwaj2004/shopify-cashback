// src/jobs/expiry.job.js
// ─────────────────────────────────────────────────────────────────────────────
// Runs on a cron schedule (default: midnight every day).
// Finds all cashback batches past their expiresAt date that are still
// ACTIVE or PARTIALLY_USED, marks them EXPIRED, and records a transaction.
// ─────────────────────────────────────────────────────────────────────────────

const cron = require("node-cron");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const logger = require("../utils/logger");

async function runExpiryJob() {
  logger.info("Expiry job: starting");

  const now = new Date();

  // Find all batches that are past expiry and not already expired
  const expiredBatches = await prisma.cashbackBatch.findMany({
    where: {
      expiresAt: { lte: now },
      status: { in: ["ACTIVE", "PARTIALLY_USED"] },
    },
    include: { wallet: true },
  });

  if (expiredBatches.length === 0) {
    logger.info("Expiry job: no batches to expire");
    return;
  }

  logger.info(`Expiry job: expiring ${expiredBatches.length} batches`);

  let totalExpired = 0;

  for (const batch of expiredBatches) {
    const remaining = parseFloat(
      (batch.originalAmount - batch.usedAmount - batch.expiredAmount).toFixed(2)
    );

    if (remaining <= 0) {
      // Nothing left to expire — just mark the status
      await prisma.cashbackBatch.update({
        where: { id: batch.id },
        data: { status: "EXPIRED" },
      });
      continue;
    }

    await prisma.$transaction(async (tx) => {
      await tx.cashbackBatch.update({
        where: { id: batch.id },
        data: {
          expiredAmount: { increment: remaining },
          status: "EXPIRED",
        },
      });

      await tx.walletTransaction.create({
        data: {
          walletId: batch.walletId,
          batchId: batch.id,
          type: "EXPIRE",
          amount: remaining,
          balanceBefore: remaining,
          balanceAfter: 0,
          orderName: batch.orderName,
          note: `Cashback batch ${batch.batchRef} expired after 30 days`,
        },
      });

      await tx.wallet.update({
        where: { id: batch.walletId },
        data: { totalExpired: { increment: remaining } },
      });
    });

    totalExpired += remaining;
    logger.info(`Expired batch ${batch.batchRef}: ₹${remaining}`);
  }

  logger.info(`Expiry job: complete. Total expired: ₹${totalExpired.toFixed(2)}`);
}

function startExpiryJob() {
  const schedule = process.env.EXPIRY_CRON_SCHEDULE || "0 0 * * *"; // midnight daily
  logger.info(`Expiry cron scheduled: ${schedule}`);

  cron.schedule(schedule, async () => {
    try {
      await runExpiryJob();
    } catch (err) {
      logger.error("Expiry job failed", { error: err.message, stack: err.stack });
    }
  });
}

module.exports = { startExpiryJob, runExpiryJob };
