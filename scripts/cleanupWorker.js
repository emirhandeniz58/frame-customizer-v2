import prisma from "../app/db.server";
import { shopifyApi, LATEST_API_VERSION } from "@shopify/shopify-api";
import { sessionStorage } from "../app/shopify.server";

const CLEANUP_INTERVAL_MS = 120 * 60 * 1000;

const DAILY_CLEANUP_TIME = { hour: 3, minute: 0 };

const ERROR_THRESHOLD = 3;
const ERROR_WINDOW_MS = 5 * 60 * 1000;
let recentErrors = [];

const api = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  scopes: process.env.SCOPES?.split(","),
  hostName: (process.env.SHOPIFY_APP_URL || "").replace(/^https?:\/\//, ""),
  apiVersion: LATEST_API_VERSION,
});

function trackError(error, context = {}) {
  const errorLog = {
    timestamp: Date.now(),
    error: error.message,
    context,
  };

  recentErrors.push(errorLog);

  const cutoff = Date.now() - ERROR_WINDOW_MS;
  recentErrors = recentErrors.filter((e) => e.timestamp > cutoff);

  if (recentErrors.length >= ERROR_THRESHOLD) {
    sendAlarm(
      `Cleanup sistemi ${ERROR_THRESHOLD} hataya ulaştı!`,
      recentErrors,
    );
  }

  console.error("Cleanup error tracked:", errorLog);
}

async function sendAlarm(message, errors) {
  console.error("🚨 ALARM:", message);
  console.error("Recent errors:", JSON.stringify(errors, null, 2));

  try {
    await prisma.cleanupLog.create({
      data: {
        action: "alarm",
        message: message,
        errorDetails: JSON.stringify(errors, null, 2),
      },
    });
  } catch (err) {
    console.error("Alarm log yazılamadı:", err);
  }
}

async function runCleanupPass() {
  console.log("🧹 Cleanup pass started:", new Date().toISOString());

  const now = new Date();

  const stats = {
    checked: 0,
    deleted: 0,
    errors: 0,
    skipped: 0,
  };

  try {
    const toDelete = await prisma.temporaryProduct.findMany({
      where: {
        scheduledDeletionAt: { lte: now },
        deletedAt: null,
        isOrdered: false,
      },
      orderBy: {
        scheduledDeletionAt: "asc",
      },
    });

    stats.checked = toDelete.length;

    if (!toDelete.length) {
      console.log("✅ Silinecek varyant yok.");
      await logCleanupAction(
        "cleanup_run",
        null,
        null,
        "No items to delete",
        null,
      );
      return stats;
    }

    console.log(`📋 ${toDelete.length} varyant silinecek`);

    for (const item of toDelete) {
      try {
        await deleteTemporaryVariant(item);
        stats.deleted++;

        await logCleanupAction(
          "deleted",
          item.productId,
          item.variantId,
          `Temporary variant deleted successfully (${item.boy}×${item.en}cm, ${item.materyal})`,
          null,
        );
      } catch (err) {
        stats.errors++;
        trackError(err, {
          variantId: item.variantId,
          productId: item.productId,
        });

        await prisma.temporaryProduct.update({
          where: { id: item.id },
          data: {
            cleanupAttempts: { increment: 1 },
            lastCleanupError: String(err.message || err),
          },
        });

        await logCleanupAction(
          "error",
          item.productId,
          item.variantId,
          "Cleanup failed",
          String(err),
        );
      }
    }

    await logCleanupAction(
      "cleanup_run",
      null,
      null,
      `Cleanup pass completed: ${stats.deleted} deleted, ${stats.errors} errors`,
      JSON.stringify(stats),
    );
  } catch (err) {
    console.error("Cleanup pass global hatası:", err);
    trackError(err, { stage: "cleanup_pass" });
  }

  return stats;
}

async function runDailyFullScan() {
  try {
    const allRecords = await prisma.temporaryProduct.findMany({
      where: {
        deletedAt: null,
      },
    });

    let cleaned = 0;
    let errors = 0;

    for (const item of allRecords) {
      try {
        const age = Date.now() - new Date(item.createdAt).getTime();
        const ageHours = age / (1000 * 60 * 60);

        if (ageHours >= 24) {
          await deleteTemporaryVariant(item);
          cleaned++;
        }
      } catch (err) {
        console.error(`Günlük tarama hatası (${item.variantId}):`, err);
        errors++;
      }
    }

    await logCleanupAction(
      "daily_scan",
      null,
      null,
      `Daily full scan completed: ${cleaned} deleted, ${errors} errors from ${allRecords.length} total`,
      null,
    );
  } catch (err) {
    console.error("Günlük tarama global hatası:", err);
    trackError(err, { stage: "daily_scan" });
  }
}

async function deleteTemporaryVariant(item) {
  const adminSession = await sessionStorage.loadSession(item.sessionId);
  if (!adminSession) {
    throw new Error("Admin session not found");
  }

  const admin = new api.clients.Rest({ session: adminSession });

  try {
    await admin.get({ path: `variants/${item.variantId}` });

    await admin.delete({
      path: `products/${item.productId}/variants/${item.variantId}`,
    });
  } catch (err) {
    if (err.response?.code === 404) {
      console.log(`ℹ️ Varyant zaten silinmiş: ${item.variantId}`);
    } else {
      throw err;
    }
  }

  await prisma.temporaryProduct.update({
    where: { id: item.id },
    data: { deletedAt: new Date() },
  });
}

async function logCleanupAction(
  action,
  productId,
  variantId,
  message,
  errorDetails,
) {
  try {
    await prisma.cleanupLog.create({
      data: {
        action,
        productId,
        variantId,
        message,
        errorDetails,
      },
    });
  } catch (err) {
    console.error("Log yazma hatası:", err);
  }
}

function scheduleDailyCleanup() {
  const now = new Date();
  const scheduled = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    DAILY_CLEANUP_TIME.hour,
    DAILY_CLEANUP_TIME.minute,
    0,
  );

  if (scheduled <= now) {
    scheduled.setDate(scheduled.getDate() + 1);
  }

  const msUntilScheduled = scheduled.getTime() - now.getTime();

  setTimeout(() => {
    runDailyFullScan();
    setInterval(runDailyFullScan, 24 * 60 * 60 * 1000);
  }, msUntilScheduled);
}

async function getCleanupStats() {
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const stats = await prisma.cleanupLog.groupBy({
    by: ["action"],
    where: {
      createdAt: { gte: last24h },
    },
    _count: true,
  });

  const recentErrors = await prisma.cleanupLog.findMany({
    where: {
      action: "error",
      createdAt: { gte: last24h },
    },
    orderBy: {
      createdAt: "desc",
    },
    take: 10,
  });

  const pendingDeletion = await prisma.temporaryProduct.count({
    where: {
      deletedAt: null,
      scheduledDeletionAt: { lte: new Date() },
    },
  });

  return {
    stats,
    recentErrors,
    pendingDeletion,
    lastRun: new Date().toISOString(),
  };
}

setInterval(runCleanupPass, CLEANUP_INTERVAL_MS);

scheduleDailyCleanup();

runCleanupPass();

export { runCleanupPass, runDailyFullScan, getCleanupStats };
