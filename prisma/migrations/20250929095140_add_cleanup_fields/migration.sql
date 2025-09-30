/*
  Warnings:

  - Added the required column `shopDomain` to the `temporary_products` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_temporary_products" (
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
    "lastCleanupError" TEXT,
    "shopDomain" TEXT NOT NULL,
    "sessionId" TEXT
);
INSERT INTO "new_temporary_products" ("area", "boy", "calculatedPrice", "cleanupAttempts", "createdAt", "deletedAt", "en", "id", "isOrdered", "lastCleanupError", "materyal", "orderIds", "productId", "scheduledDeletionAt", "variantId") SELECT "area", "boy", "calculatedPrice", "cleanupAttempts", "createdAt", "deletedAt", "en", "id", "isOrdered", "lastCleanupError", "materyal", "orderIds", "productId", "scheduledDeletionAt", "variantId" FROM "temporary_products";
DROP TABLE "temporary_products";
ALTER TABLE "new_temporary_products" RENAME TO "temporary_products";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
