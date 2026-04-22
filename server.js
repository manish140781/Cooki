/**
 * Shopify ↔ Sampson Express Integration Server
 * Listens for Shopify "orders/paid" webhooks and auto-creates
 * consignments in the Sampson Express API.
 */

const express = require("express");
const crypto = require("crypto");
const axios = require("axios");

const app = express();

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  port: process.env.PORT || 3000,

  // Sampson Express
  sampson: {
    customerId: "1404",
    accountNumber: "2642447",
    accountName: "TEST",
    carrierAccountNumber: "PAR2447",
    serviceType: "CRX",
    apiUsername: process.env.SAMPSON_API_USERNAME || "2642447.cooki",
    apiPassword: process.env.SAMPSON_API_PASSWORD || "QGRvHerGMXi2EDQPKmQcRAQm7OG45aid",
    // Switch to live URL when ready:
    // apiUrl: "https://api.sampsonexpress.com.au/v3.6/customers/1404/consignment/",
    apiUrl: "https://betaapi.sampsonexpress.com.au/v3.6/customers/1404/consignment/",
  },

  // Shopify
  shopify: {
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || "YOUR_WEBHOOK_SECRET",
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN || "YOUR_ACCESS_TOKEN",
    shopDomain: process.env.SHOPIFY_SHOP_DOMAIN || "your-store.myshopify.com",
  },
};

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
// Must use raw body for HMAC verification
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ─── HMAC VERIFICATION ────────────────────────────────────────────────────────
function verifyShopifyWebhook(req) {
  const hmac = req.headers["x-shopify-hmac-sha256"];
  if (!hmac) return false;
  const digest = crypto
    .createHmac("sha256", CONFIG.shopify.webhookSecret)
    .update(req.rawBody)
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
}

// ─── MAP SHOPIFY ORDER → SAMPSON PAYLOAD ─────────────────────────────────────
function buildConsignmentPayload(order) {
  const shipping = order.shipping_address || order.billing_address || {};
  const lineItems = order.line_items || [];

  // Calculate total weight (grams → kg)
  const totalWeightKg =
    lineItems.reduce((sum, item) => sum + (item.grams || 0) * item.quantity, 0) / 1000;

  // Build items array
  const items = lineItems.map((item, idx) => ({
    itemNumber: idx + 1,
    reference: item.sku || item.id?.toString() || `ITEM-${idx + 1}`,
    description: item.name,
    quantity: item.quantity,
    weight: ((item.grams || 500) * item.quantity) / 1000, // kg
    length: 10,   // cm — update with real dimensions if available
    width: 10,
    height: 10,
  }));

  return {
    accountNumber: CONFIG.sampson.accountNumber,
    accountName: CONFIG.sampson.accountName,
    carrierAccountNumber: CONFIG.sampson.carrierAccountNumber,
    serviceType: CONFIG.sampson.serviceType,

    // Sender (your warehouse — update these)
    senderName: CONFIG.sampson.accountName,
    senderAddress1: "YOUR WAREHOUSE ADDRESS LINE 1",
    senderAddress2: "",
    senderSuburb: "YOUR SUBURB",
    senderState: "NSW",
    senderPostcode: "2000",
    senderPhone: "0200000000",

    // Receiver (from Shopify order)
    receiverName: `${shipping.first_name || ""} ${shipping.last_name || ""}`.trim(),
    receiverCompany: shipping.company || "",
    receiverAddress1: shipping.address1 || "",
    receiverAddress2: shipping.address2 || "",
    receiverSuburb: shipping.city || "",
    receiverState: shipping.province_code || shipping.province || "",
    receiverPostcode: shipping.zip || "",
    receiverPhone: shipping.phone || order.phone || "",
    receiverEmail: order.email || "",

    // Reference
    reference1: order.name || order.order_number?.toString(),  // e.g. "#1001"
    reference2: order.id?.toString(),

    // Freight details
    totalWeight: totalWeightKg || 1,
    items,

    // Options
    specialInstructions: order.note || "",
    authorityToLeave: false,
  };
}

// ─── CREATE CONSIGNMENT IN SAMPSON ───────────────────────────────────────────
async function createConsignment(payload) {
  const credentials = Buffer.from(
    `${CONFIG.sampson.apiUsername}:${CONFIG.sampson.apiPassword}`
  ).toString("base64");

  const response = await axios.post(CONFIG.sampson.apiUrl, payload, {
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
  return response.data;
}

// ─── UPDATE SHOPIFY FULFILLMENT WITH TRACKING ─────────────────────────────────
async function fulfillShopifyOrder(orderId, trackingNumber, consignmentData) {
  const baseUrl = `https://${CONFIG.shopify.shopDomain}/admin/api/2024-01`;
  const headers = {
    "X-Shopify-Access-Token": CONFIG.shopify.accessToken,
    "Content-Type": "application/json",
  };

  // 1. Get fulfillment orders
  const { data: foData } = await axios.get(
    `${baseUrl}/orders/${orderId}/fulfillment_orders.json`,
    { headers }
  );
  const fulfillmentOrders = foData.fulfillment_orders || [];
  if (!fulfillmentOrders.length) return null;

  // 2. Create fulfillment with tracking
  const { data: fulfillment } = await axios.post(
    `${baseUrl}/fulfillments.json`,
    {
      fulfillment: {
        line_items_by_fulfillment_order: fulfillmentOrders.map((fo) => ({
          fulfillment_order_id: fo.id,
        })),
        tracking_info: {
          number: trackingNumber,
          url: `https://www.sampsonexpress.com.au/track?consignment=${trackingNumber}`,
          company: "Sampson Express",
        },
        notify_customer: true,
      },
    },
    { headers }
  );

  return fulfillment;
}

// ─── WEBHOOK ENDPOINT ─────────────────────────────────────────────────────────
app.post("/webhooks/orders/paid", async (req, res) => {
  // 1. Verify it's really from Shopify
  if (!verifyShopifyWebhook(req)) {
    console.warn("⚠️  Invalid webhook signature");
    return res.status(401).send("Unauthorized");
  }

  // Respond to Shopify immediately (must be < 5s)
  res.status(200).send("OK");

  const order = req.body;
  console.log(`\n📦 New paid order: ${order.name} (ID: ${order.id})`);

  try {
    // 2. Build consignment payload
    const payload = buildConsignmentPayload(order);
    console.log("📬 Sending consignment to Sampson Express...");

    // 3. Create consignment
    const consignmentResult = await createConsignment(payload);
    console.log("✅ Consignment created:", JSON.stringify(consignmentResult, null, 2));

    // 4. Extract tracking number from response (adjust field name to match actual API response)
    const trackingNumber =
      consignmentResult.consignmentNumber ||
      consignmentResult.trackingNumber ||
      consignmentResult.connote;

    if (trackingNumber) {
      // 5. Update Shopify with tracking info
      await fulfillShopifyOrder(order.id, trackingNumber, consignmentResult);
      console.log(`🚚 Shopify order ${order.name} fulfilled with tracking: ${trackingNumber}`);
    }
  } catch (err) {
    console.error("❌ Integration error:", err.response?.data || err.message);
    // TODO: Add retry logic / alerting here
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── TEST ENDPOINT (remove in production) ────────────────────────────────────
app.post("/test/consignment", async (req, res) => {
  try {
    const testPayload = buildConsignmentPayload(req.body);
    const result = await createConsignment(testPayload);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(CONFIG.port, () => {
  console.log(`\n🚀 Shopify-Sampson Integration Server running on port ${CONFIG.port}`);
  console.log(`   Webhook endpoint: POST /webhooks/orders/paid`);
  console.log(`   Health check:     GET  /health`);
  console.log(`   Sampson API:      ${CONFIG.sampson.apiUrl}\n`);
});
