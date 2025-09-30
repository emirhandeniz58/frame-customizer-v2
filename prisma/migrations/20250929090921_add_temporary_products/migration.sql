-- CreateTable
CREATE TABLE "temporary_products" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduledDeletionAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "boy" INTEGER NOT NULL,
    "en" INTEGER NOT NULL,
    "materyal" TEXT NOT NULL,
    "calculatedPrice" REAL NOT NULL,
    "area" INTEGER NOT NULL,
    "isOrdered" BOOLEAN NOT NULL DEFAULT false,
    "orderIds" JSONB NOT NULL DEFAULT [],
    "cleanupAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastCleanupError" TEXT
);

-- CreateTable
CREATE TABLE "cleanup_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT NOT NULL,
    "productId" TEXT,
    "variantId" TEXT,
    "message" TEXT NOT NULL,
    "errorDetails" TEXT
);
