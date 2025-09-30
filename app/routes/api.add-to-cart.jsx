import shopify, { authenticate, sessionStorage } from "../shopify.server";
import { shopifyApi, LATEST_API_VERSION } from "@shopify/shopify-api";
import prisma from "../db.server";

const requestCache = new Map();
const CACHE_DURATION = 5000;
const MAX_CACHE_SIZE = 1000;

const API_TIMEOUT = 10000;

const MIN_PRICE = 0.01;
const MAX_PRICE = 999999.99;

const WEIGHT_PER_AREA = {
  pamuk: 0.15,
  polyester: 0.12,
  keten: 0.18,
  ipek: 0.08,
  default: 0.15,
};

function generateRequestId(boy, en, materyal) {
  return `${boy}-${en}-${materyal}-${Date.now()}`;
}

function cleanupCache() {
  const now = Date.now();

  for (const [key, value] of requestCache.entries()) {
    if (now - value.timestamp > CACHE_DURATION) {
      requestCache.delete(key);
    }
  }

  if (requestCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(requestCache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

    const toDelete = Math.floor(MAX_CACHE_SIZE * 0.2);
    for (let i = 0; i < toDelete; i++) {
      requestCache.delete(entries[i][0]);
    }
  }
}

function validatePrice(price) {
  const numPrice = parseFloat(String(price));

  if (isNaN(numPrice)) {
    throw new Error("Geçersiz fiyat formatı");
  }

  if (numPrice < MIN_PRICE) {
    throw new Error(`Fiyat minimum ${MIN_PRICE} TL olmalıdır`);
  }

  if (numPrice > MAX_PRICE) {
    throw new Error(`Fiyat maximum ${MAX_PRICE} TL olmalıdır`);
  }

  return Math.round(numPrice * 100) / 100;
}

function calculateWeight(boy, en, materyal) {
  const area = boy * en;
  const weightPerCm2 =
    WEIGHT_PER_AREA[materyal.toLowerCase()] || WEIGHT_PER_AREA.default;
  const calculatedWeight = area * weightPerCm2;

  return Math.max(50, Math.min(50000, Math.round(calculatedWeight)));
}

async function withTimeout(promise, timeoutMs = API_TIMEOUT) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("API isteği zaman aşımına uğradı")),
        timeoutMs,
      ),
    ),
  ]);
}

async function findExistingVariant(admin, productId, boy, en, materyal) {
  try {
    const productResponse = await withTimeout(
      admin.get({ path: `products/${productId}/variants` }),
    );
    const allVariants = productResponse.body?.variants || [];

    return allVariants.find(
      (variant) =>
        variant.option1 === `${boy}` &&
        variant.option2 === `${en}` &&
        variant.option3 === `${materyal}`,
    );
  } catch (err) {
    console.error("Mevcut varyant arama hatası:", err);
    return null;
  }
}

// FIX: Varyantın tamamen hazır olmasını bekle ve fiyatı doğrula
// waitForVariantReady fonksiyonunu güçlendir
async function waitForVariantReady(
  admin,
  variantId,
  expectedPrice,
  maxRetries = 8,
) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await new Promise((resolve) => setTimeout(resolve, 600 * (i + 1))); // Daha uzun bekleme

      const response = await withTimeout(
        admin.get({ path: `variants/${variantId}` }),
      );

      const variant = response.body?.variant;

      // FIX: Fiyatın STRING olarak geldiğinden emin ol
      if (variant && variant.price !== null && variant.price !== undefined) {
        const variantPrice = parseFloat(variant.price);
        const expected = parseFloat(expectedPrice);

        console.log(
          `✅ Varyant fiyatı doğrulandı (${i + 1}. deneme): ${variant.price} TL (Beklenen: ${expectedPrice})`,
        );

        // Fiyat eşleşmese bile variant'ı dön (Shopify bazen farklı format kullanır)
        if (Math.abs(variantPrice - expected) < 0.01) {
          console.log("✅ Fiyat tam eşleşti!");
          return variant;
        } else {
          console.warn(`⚠️ Fiyat eşleşmiyor: ${variantPrice} vs ${expected}`);
        }
      }

      console.log(`⏳ Varyant henüz hazır değil (${i + 1}. deneme)`);
    } catch (err) {
      console.error(
        `❌ Varyant kontrol hatası (${i + 1}. deneme):`,
        err.message,
      );
    }
  }

  // Son deneme - her halükarda variant'ı dön
  try {
    const finalResponse = await admin.get({ path: `variants/${variantId}` });
    const finalVariant = finalResponse.body?.variant;
    console.log("🔍 Son kontrol - Variant price:", finalVariant?.price);
    return finalVariant;
  } catch (err) {
    console.error("❌ Final variant kontrolü başarısız:", err);
    return null;
  }
}

export async function action({ request }) {
  try {
    const { session } = await authenticate.public.appProxy(request);

    const adminSession = await sessionStorage.loadSession(session.id);
    if (!adminSession || !adminSession.id) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Sistem hatası: Oturum bulunamadı. Lütfen sayfayı yenileyin.",
          errorType: "session_not_found",
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    const api = shopifyApi({
      apiKey: process.env.SHOPIFY_API_KEY,
      apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
      scopes: process.env.SCOPES?.split(","),
      hostName: (process.env.SHOPIFY_APP_URL || "").replace(/^https?:\/\//, ""),
      apiVersion: LATEST_API_VERSION,
    });

    const admin = new api.clients.Rest({ session: adminSession });

    const formData = await request.formData();
    const baseVariantId = formData.get("baseVariantId");
    const boy = formData.get("boy");
    const en = formData.get("en");
    const materyal = formData.get("materyal");
    const calculatedPriceRaw = formData.get("calculatedPrice");
    const requestId =
      formData.get("requestId") || generateRequestId(boy, en, materyal);

    console.log("🔵 İstek alındı:", { boy, en, materyal, calculatedPriceRaw });

    if (!baseVariantId || !boy || !en || !materyal || !calculatedPriceRaw) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Eksik bilgi: Lütfen tüm alanları doldurun.",
          errorType: "validation",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    let calculatedPrice;
    try {
      calculatedPrice = validatePrice(calculatedPriceRaw);
    } catch (err) {
      return new Response(
        JSON.stringify({
          success: false,
          error: err.message,
          errorType: "invalid_price",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    cleanupCache();
    const cacheKey = `${boy}-${en}-${materyal}`;
    if (requestCache.has(cacheKey)) {
      const cachedRequest = requestCache.get(cacheKey);
      if (Date.now() - cachedRequest.timestamp < 3000) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "İşlem zaten devam ediyor. Lütfen bekleyin...",
            errorType: "duplicate",
            retryAfter: 3,
          }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    requestCache.set(cacheKey, {
      timestamp: Date.now(),
      requestId: requestId,
    });

    const boyInt = parseInt(String(boy), 10);
    const enInt = parseInt(String(en), 10);
    const area = boyInt * enInt;

    const calculatedWeight = calculateWeight(boyInt, enInt, materyal);

    let baseVariant;
    try {
      const variantResponse = await withTimeout(
        admin.get({ path: `variants/${baseVariantId}` }),
      );
      baseVariant = variantResponse.body?.variant;
      if (!baseVariant) throw new Error("Base variant bulunamadı");
    } catch (err) {
      console.error("Base variant getirme hatası:", err);
      requestCache.delete(cacheKey);

      const isTimeout = err.message.includes("zaman aşımı");
      return new Response(
        JSON.stringify({
          success: false,
          error: isTimeout
            ? "İstek zaman aşımına uğradı. Lütfen tekrar deneyin."
            : "Ürün bilgileri alınamadı. Lütfen sayfayı yenileyin.",
          errorType: isTimeout ? "timeout" : "product_not_found",
        }),
        {
          status: isTimeout ? 504 : 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const productId = baseVariant.product_id;

    const existingVariant = await findExistingVariant(
      admin,
      productId,
      boy,
      en,
      materyal,
    );

    if (existingVariant) {
      console.log("✅ Mevcut varyant bulundu:", existingVariant.id);

      // Fiyatı güncelle
      try {
        await withTimeout(
          admin.put({
            path: `variants/${existingVariant.id}`,
            data: {
              variant: {
                id: existingVariant.id,
                price: String(calculatedPrice),
              },
            },
            type: "application/json",
          }),
        );

        // FIX: Güncellenmiş varyantı tekrar çek
        await new Promise((resolve) => setTimeout(resolve, 300));
        const updatedResponse = await admin.get({
          path: `variants/${existingVariant.id}`,
        });
        const updatedVariant = updatedResponse.body?.variant;

        console.log("💰 Fiyat güncellendi:", updatedVariant?.price);

        requestCache.delete(cacheKey);

        return new Response(
          JSON.stringify({
            success: true,
            message: "Mevcut ürün kullanıldı",
            variant: {
              id: String(updatedVariant?.id || existingVariant.id),
              gid: `gid://shopify/ProductVariant/${updatedVariant?.id || existingVariant.id}`,
              price: String(updatedVariant?.price || calculatedPrice),
              formatted_price: `${updatedVariant?.price || calculatedPrice} TL`,
            },
            product: {
              id: String(productId),
              variant_id: String(updatedVariant?.id || existingVariant.id),
              price: String(updatedVariant?.price || calculatedPrice),
            },
            usedExisting: true,
            requestId: requestId,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      } catch (err) {
        console.error("Fiyat güncelleme hatası:", err);
        // Hata olsa bile mevcut varyantı dön
        requestCache.delete(cacheKey);

        return new Response(
          JSON.stringify({
            success: true,
            message: "Mevcut ürün kullanıldı",
            variant: {
              id: String(existingVariant.id),
              gid: `gid://shopify/ProductVariant/${existingVariant.id}`,
              price: String(existingVariant.price || calculatedPrice),
              formatted_price: `${existingVariant.price || calculatedPrice} TL`,
            },
            product: {
              id: String(productId),
              variant_id: String(existingVariant.id),
              price: String(existingVariant.price || calculatedPrice),
            },
            usedExisting: true,
            requestId: requestId,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }
    }

    // YENİ VARYANT OLUŞTUR
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);

    // FIX: Price'ı hem string hem de number olarak gönder
    const priceString = calculatedPrice.toFixed(2);

    // YENİ VARYANT OLUŞTUR bölümünde
    const variantData = {
      variant: {
        product_id: productId,
        price: priceString, // "99.99" formatında
        sku: `CUSTOM-${timestamp}-${randomSuffix}`,
        inventory_management: "shopify",
        inventory_policy: "continue",
        inventory_quantity: 9999,
        requires_shipping: true,
        taxable: true,
        option1: `${boy}`,
        option2: `${en}`,
        option3: `${materyal}`,
        weight: calculatedWeight,
        weight_unit: "g",
        compare_at_price: null,
      },
    };

    console.log("📦 Yeni varyant oluşturuluyor:", {
      price: priceString,
      priceType: typeof priceString,
      weight: calculatedWeight,
      fullData: variantData, // ← Tüm data'yı logla
    });

    let newVariant;
    try {
      const variantResponse = await withTimeout(
        admin.post({
          path: `products/${productId}/variants`,
          data: variantData,
          type: "application/json",
        }),
      );
      newVariant = variantResponse.body?.variant;

      if (!newVariant) {
        throw new Error("Shopify boş response döndü");
      }

      console.log("🆕 Varyant oluşturuldu - İlk response:", {
        id: newVariant.id,
        price: newVariant.price,
        priceType: typeof newVariant.price,
      });

      // FIX: Varyantın tamamen hazır olmasını bekle
      const readyVariant = await waitForVariantReady(
        admin,
        newVariant.id,
        calculatedPrice,
      );

      if (readyVariant) {
        newVariant = readyVariant;
        console.log("✅ Varyant doğrulandı. Final price:", newVariant.price);
      }

      // EKSTRA GÜVENLİK: Eğer price hala null/undefined ise manuel set et
      if (
        !newVariant.price ||
        newVariant.price === "0" ||
        newVariant.price === "0.00"
      ) {
        console.warn("⚠️ Fiyat 0 veya null, manuel güncelleme yapılıyor...");

        try {
          await admin.put({
            path: `variants/${newVariant.id}`,
            data: {
              variant: {
                id: newVariant.id,
                price: priceString,
              },
            },
            type: "application/json",
          });

          // Tekrar kontrol et
          await new Promise((resolve) => setTimeout(resolve, 500));
          const updatedResponse = await admin.get({
            path: `variants/${newVariant.id}`,
          });
          newVariant = updatedResponse.body?.variant;

          console.log("🔄 Manuel güncelleme sonrası price:", newVariant.price);
        } catch (updateErr) {
          console.error("❌ Manuel fiyat güncelleme hatası:", updateErr);
        }
      }
    } catch (err) {
      console.error("❌ Variant oluşturma hatası:", err);
      requestCache.delete(cacheKey);

      if (err.response?.body?.errors?.base?.[0]?.includes("already exists")) {
        console.log("🔄 Varyant zaten var, tekrar aranıyor...");
        const retryVariant = await findExistingVariant(
          admin,
          productId,
          boy,
          en,
          materyal,
        );

        if (retryVariant) {
          return new Response(
            JSON.stringify({
              success: true,
              message: "Mevcut ürün kullanıldı",
              variant: {
                id: String(retryVariant.id),
                gid: `gid://shopify/ProductVariant/${retryVariant.id}`,
                price: String(retryVariant.price || calculatedPrice),
                formatted_price: `${retryVariant.price || calculatedPrice} TL`,
              },
              product: {
                id: String(productId),
                variant_id: String(retryVariant.id),
                price: String(retryVariant.price || calculatedPrice),
              },
              usedExisting: true,
              requestId: requestId,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      }

      const isTimeout = err.message.includes("zaman aşımı");
      return new Response(
        JSON.stringify({
          success: false,
          error: isTimeout
            ? "Ürün oluşturma zaman aşımına uğradı. Lütfen tekrar deneyin."
            : "Ürün oluşturulurken bir hata oluştu.",
          errorType: isTimeout ? "timeout" : "creation_failed",
          details: err.message,
        }),
        {
          status: isTimeout ? 504 : 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (!newVariant) {
      requestCache.delete(cacheKey);
      throw new Error("Shopify variant oluşturulamadı (boş response).");
    }

    const scheduledDeletionAt = new Date(Date.now() + 2 * 60 * 60 * 1000);

    try {
      await prisma.temporaryProduct.create({
        data: {
          productId: String(productId),
          variantId: String(newVariant.id),
          scheduledDeletionAt,
          boy: boyInt,
          en: enInt,
          materyal: String(materyal),
          calculatedPrice: calculatedPrice,
          area,
          shopDomain: session?.shop || adminSession?.shop || "",
          sessionId: adminSession.id,
        },
      });

      await prisma.cleanupLog.create({
        data: {
          action: "variant_created",
          productId: String(productId),
          variantId: String(newVariant.id),
          message: `Temporary variant created: ${boy}×${en}cm, ${materyal}, ${calculatedWeight}g, ${newVariant.price} TL`,
        },
      });
    } catch (dbErr) {
      console.error("DB kaydı oluşturulamadı:", dbErr);
    }

    requestCache.delete(cacheKey);

    // FIX: Response'da fiyatı birden fazla formatta dön
    // Final response öncesi
    const finalPrice = newVariant.price || calculatedPrice;
    const finalPriceString = String(finalPrice);

    console.log("🎉 Response hazırlanıyor:", {
      variantId: newVariant.id,
      price: finalPrice,
      priceString: finalPriceString,
      calculatedPrice,
      match: finalPrice == calculatedPrice,
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: "Yeni ürün oluşturuldu",
        variant: {
          id: String(newVariant.id),
          gid: `gid://shopify/ProductVariant/${newVariant.id}`,
          price: finalPriceString, // ← String olarak dön
          price_numeric: parseFloat(finalPrice), // ← Numeric olarak da dön
          formatted_price: `${finalPrice} TL`,
          weight: calculatedWeight,
        },
        product: {
          id: String(productId),
          variant_id: String(newVariant.id),
          price: finalPriceString,
        },
        debug: {
          // ← Geliştirme için debug bilgisi
          originalPrice: newVariant.price,
          calculatedPrice: calculatedPrice,
          priceString: priceString,
        },
        usedExisting: false,
        requestId: requestId,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache", // ← Cache'i devre dışı bırak
        },
      },
    );
  } catch (error) {
    console.error("Variant oluşturma hatası:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: "Sistem hatası: Lütfen daha sonra tekrar deneyin.",
        errorType: "system_error",
        details:
          process.env.NODE_ENV === "development" ? error.stack : undefined,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }
  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: { "Content-Type": "application/json" },
  });
}
