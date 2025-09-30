// app/routes/api.custom-product.jsx
import shopify, { authenticate, sessionStorage } from "../shopify.server";
import { shopifyApi, LATEST_API_VERSION } from "@shopify/shopify-api";

export async function action({ request }) {
  try {
    const { session } = await authenticate.public.appProxy(request);

    const adminSession = await sessionStorage.loadSession(session.id);

    if (!adminSession) {
      throw new Error("Admin session bulunamadı");
    }

    const api = shopifyApi({
      apiKey: process.env.SHOPIFY_API_KEY,
      apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
      scopes: process.env.SCOPES?.split(","),
      hostName: process.env.SHOPIFY_APP_URL?.replace(/^https?:\/\//, ""),
      apiVersion: LATEST_API_VERSION,
    });

    const admin = new api.clients.Rest({ session: adminSession });

    // Form verilerini al
    const formData = await request.formData();
    const boy = formData.get("boy");
    const en = formData.get("en");
    const materyal = formData.get("materyal");
    const calculatedPrice = formData.get("calculatedPrice");

    console.log("Özel ürün oluşturma isteği:", {
      boy,
      en,
      materyal,
      calculatedPrice,
    });

    // Validasyon
    if (!boy || !en || !materyal || !calculatedPrice) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Eksik parametreler: boy, en, materyal ve fiyat gerekli",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Ürün bilgileri
    const productTitle = `Özel Masa ${boy}×${en}cm - ${materyal}`;
    const productHandle = `ozel-masa-${boy}x${en}-${materyal
      .toLowerCase()
      .replace(/\s+/g, "-")}-${Date.now()}`;
    const area = parseInt(boy) * parseInt(en);

    // 1. Ürünü oluştur
    const productResponse = await admin.post({
      path: "products",
      data: {
        product: {
          title: productTitle,
          handle: productHandle,
          body_html: `
            <h3>Özel Tasarım Masa</h3>
            <ul>
              <li><strong>Boy:</strong> ${boy} cm</li>
              <li><strong>En:</strong> ${en} cm</li>
              <li><strong>Materyal:</strong> ${materyal}</li>
              <li><strong>Alan:</strong> ${area.toLocaleString("tr-TR")} cm²</li>
            </ul>
            <p><em>Bu özel tasarım bir üründür.</em></p>
          `,
          product_type: "Custom Furniture",
          vendor: "Custom Design",
          status: "active", // Aktif ürün
          tags: `custom,masa,özel,${materyal.toLowerCase()}`,
          published_scope: "global",
          variants: [
            {
              price: calculatedPrice,
              sku: `CUSTOM-${Date.now()}`,
              inventory_management: null,
              inventory_policy: "continue",
              requires_shipping: true,
              taxable: true,
              option1: "Default",
            },
          ],
        },
      },
      type: "application/json",
    });

    const product = productResponse.body.product;
    console.log("Ürün oluşturuldu:", product.id);

    // 2. Draft Order oluştur (sepete ekleme için)
    const draftOrderResponse = await admin.post({
      path: "draft_orders",
      data: {
        draft_order: {
          line_items: [
            {
              variant_id: product.variants[0].id,
              quantity: 1,
              title: product.title,
              price: calculatedPrice,
            },
          ],
          note: `Özel masa - Boy: ${boy}cm, En: ${en}cm, Materyal: ${materyal}`,
        },
      },
      type: "application/json",
    });

    const draftOrder = draftOrderResponse.body.draft_order;
    console.log("Draft order oluşturuldu:", draftOrder.id);

    return new Response(
      JSON.stringify({
        success: true,
        product: {
          id: product.id,
          title: product.title,
          handle: product.handle,
          variant_id: product.variants[0].id,
          price: product.variants[0].price,
          url: `/products/${product.handle}`,
        },
        draft_order: {
          id: draftOrder.id,
          invoice_url: draftOrder.invoice_url,
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      },
    );
  } catch (error) {
    console.error("Ürün oluşturma hatası:", error);

    return new Response(
      JSON.stringify({
        success: false,
        error: "Ürün oluşturulamadı: " + error.message,
        details: error.stack,
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

// OPTIONS isteği için CORS desteği
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

  return new Response(
    JSON.stringify({
      error: "Method not allowed",
    }),
    {
      status: 405,
      headers: { "Content-Type": "application/json" },
    },
  );
}
