import express from "express";
import admin from "firebase-admin";
import { Expo } from "expo-server-sdk";
import Typesense from "typesense";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

// =========================
// Load service account (ENV first, then file)
// =========================
let serviceAccount = null;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
} else {
  const serviceAccountPathEnv =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "./serviceAccountKey.json";
  const serviceAccountPath = path.resolve(process.cwd(), serviceAccountPathEnv);

  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error(
      `Service account file not found: ${serviceAccountPath}\n` +
        `Put your serviceAccountKey.json inside push-server folder OR set FIREBASE_SERVICE_ACCOUNT_JSON in env`
    );
  }

  try {
    serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
  } catch {
    throw new Error("Failed to read/parse serviceAccountKey.json (invalid JSON).");
  }
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const expo = new Expo();
const app = express();

// =========================
// Typesense
// =========================
const TYPESENSE_COLLECTION = process.env.TYPESENSE_COLLECTION || "products";

let typesense = null;
if (
  process.env.TYPESENSE_HOST &&
  process.env.TYPESENSE_ADMIN_API_KEY
) {
  typesense = new Typesense.Client({
    nodes: [
      {
        host: process.env.TYPESENSE_HOST,
        port: Number(process.env.TYPESENSE_PORT || 443),
        protocol: process.env.TYPESENSE_PROTOCOL || "https",
      },
    ],
    apiKey: process.env.TYPESENSE_ADMIN_API_KEY,
    connectionTimeoutSeconds: 10,
  });
} else {
  console.warn("Typesense env vars are missing. Typesense sync endpoints will not work.");
}

// =========================
// Helpers
// =========================
function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function pickBestToken(doc) {
  const d = doc || {};
  if (typeof d.deviceToken === "string" && d.deviceToken.length > 20) return d.deviceToken;
  if (typeof d.fcmToken === "string" && d.fcmToken.length > 20) return d.fcmToken;
  if (d.tokenType === "fcm" && typeof d.token === "string" && d.token.length > 20) return d.token;
  if (typeof d.expoToken === "string" && d.expoToken.length > 20) return d.expoToken;
  if (typeof d.token === "string" && d.token.length > 20) return d.token;
  return null;
}

function isExpoToken(t) {
  return typeof t === "string" && t.startsWith("ExponentPushToken[");
}

function unique(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

function truthy(value) {
  return value !== undefined && value !== null && value !== "";
}

function safeString(value) {
  return typeof value === "string" ? value : truthy(value) ? String(value) : "";
}

function normalizeProductDoc(product) {
  const p = product || {};
  const id = safeString(p.id || p.productId || p.docId);
  if (!id) return null;

  const name = safeString(p.name || p.title || p.productName).trim();
  const storeId = safeString(p.storeId).trim();
  const category = safeString(p.category || p.section || p.sectionName).trim();
  const description = safeString(p.description || p.desc).trim();
  const imageUrl = safeString(p.imageUrl || p.image || p.photoUrl).trim();
  const sku = safeString(p.sku || p.barcode).trim();
  const unit = safeString(p.unit).trim();
  const tags = Array.isArray(p.tags) ? p.tags.map((x) => safeString(x)).filter(Boolean) : [];
  const inStock = p.inStock === undefined ? true : !!p.inStock;
  const isHidden = !!p.isHidden;
  const isActive = p.isActive === undefined ? true : !!p.isActive;
  const price = toNumber(p.price ?? p.salePrice ?? p.unitPrice);
  const compareAtPrice = toNumber(p.compareAtPrice ?? p.originalPrice ?? p.oldPrice);
  const rating = toNumber(p.rating);
  const sortOrder = toNumber(p.sortOrder ?? p.order ?? 0);
  const createdAt = safeString(p.createdAt || "");
  const updatedAt = safeString(p.updatedAt || "");

  const searchableText = [
    name,
    category,
    description,
    storeId,
    sku,
    unit,
    ...tags,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

  return {
    id,
    name,
    storeId,
    category,
    description,
    imageUrl,
    sku,
    unit,
    tags,
    inStock,
    isHidden,
    isActive,
    price,
    compareAtPrice,
    rating,
    sortOrder,
    createdAt,
    updatedAt,
    searchableText,
  };
}

async function verifyFirebaseToken(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const match = auth.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return res.status(401).json({ ok: false, error: "Missing Bearer token" });
    }

    const decoded = await admin.auth().verifyIdToken(match[1]);
    const userDoc = await db.collection("users").doc(decoded.uid).get();

    if (!userDoc.exists) {
      return res.status(403).json({ ok: false, error: "User profile not found" });
    }

    req.authUser = {
      uid: decoded.uid,
      email: decoded.email || "",
      ...(userDoc.data() || {}),
    };

    next();
  } catch (e) {
    console.error("verifyFirebaseToken error:", e);
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
}

function ensureAdminOrOwner(req, res, next) {
  const role = req.authUser?.role;
  if (role === "admin" || role === "owner") return next();
  return res.status(403).json({ ok: false, error: "Only admin or owner allowed" });
}

function ensureOwnerScope(req, res, next) {
  const role = req.authUser?.role;
  if (role === "admin") return next();

  const ownerStoreId = safeString(req.authUser?.ownerStoreId);
  const products = Array.isArray(req.body?.products) ? req.body.products : [];
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const storeId = safeString(req.body?.storeId);

  if (role !== "owner") {
    return res.status(403).json({ ok: false, error: "Only admin or owner allowed" });
  }

  if (!ownerStoreId) {
    return res.status(403).json({ ok: false, error: "Owner store not linked" });
  }

  if (products.length) {
    const bad = products.find((p) => safeString(p?.storeId) !== ownerStoreId);
    if (bad) {
      return res.status(403).json({ ok: false, error: "Owner can only sync own store products" });
    }
  }

  if (ids.length && storeId && storeId !== ownerStoreId) {
    return res.status(403).json({ ok: false, error: "Owner can only delete own store products" });
  }

  if (!products.length && !ids.length) {
    return res.status(400).json({ ok: false, error: "No products or ids provided" });
  }

  next();
}

// حساب قيمة المشتريات (بدون توصيل) من order أو من lines
function computeItemsTotal(order) {
  if (order && order.itemsTotal != null) return toNumber(order.itemsTotal);

  const lines = Array.isArray(order?.lines) ? order.lines : [];
  return lines.reduce((sum, l) => {
    const price = toNumber(l?.price);
    const qty =
      l?.qty != null ? toNumber(l.qty) :
      l?.weightKg != null ? toNumber(l.weightKg) :
      l?.kg != null ? toNumber(l.kg) :
      l?.quantity != null ? toNumber(l.quantity) : 1;

    return sum + price * qty;
  }, 0);
}

function computeDeliveryFee(order) {
  if (order && order.deliveryFee != null) return toNumber(order.deliveryFee);
  return 20;
}

function computeGrandTotal(order) {
  const delivery = computeDeliveryFee(order);

  if (order && order.total != null && order.deliveryFee != null) {
    return toNumber(order.total);
  }

  const itemsTotal = computeItemsTotal(order);
  return itemsTotal + delivery;
}

function getStoreLabel(order) {
  return order?.storeName || order?.storeTitle || order?.storeLabel || order?.storeId || "-";
}

function getLineNames(order) {
  const lines = Array.isArray(order?.lines) ? order.lines : [];
  const names = lines.map((l) => String(l?.name || "").trim()).filter(Boolean);
  if (!names.length) return "-";
  return names.slice(0, 4).join("، ") + (names.length > 4 ? "..." : "");
}

// =========================
// CORS
// =========================
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "10mb" }));

// =========================
// Health check
// =========================
app.get("/health", (_req, res) => {
  res.json({ ok: true, message: "Push server is running" });
});

app.get("/typesense/health", async (_req, res) => {
  try {
    if (!typesense) {
      return res.status(500).json({ ok: false, error: "Typesense is not configured" });
    }
    const health = await typesense.health.retrieve();
    return res.json({ ok: true, health });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// =========================
// Send push (Expo + FCM)
// =========================
async function sendPush(tokens, title, body, data = {}) {
  const cleanTokens = unique(tokens);
  const expoTokens = cleanTokens.filter((t) => isExpoToken(t));
  const fcmTokens = cleanTokens.filter((t) => t && !isExpoToken(t));

  if (expoTokens.length) {
    const messages = [];
    for (const token of expoTokens) {
      if (!token) continue;
      if (!Expo.isExpoPushToken(token)) continue;
      messages.push({ to: token, sound: "default", title, body, data });
    }

    if (messages.length) {
      const chunks = expo.chunkPushNotifications(messages);
      for (const chunk of chunks) {
        try {
          await expo.sendPushNotificationsAsync(chunk);
        } catch (e) {
          console.error("Expo push send error:", e);
        }
      }
    }
  }

  if (fcmTokens.length) {
    try {
      const dataStr = Object.fromEntries(
        Object.entries(data || {}).map(([k, v]) => [
          k,
          typeof v === "string" ? v : JSON.stringify(v),
        ])
      );

      await admin.messaging().sendEachForMulticast({
        tokens: fcmTokens,
        notification: { title, body },
        data: dataStr,
        android: {
          priority: "high",
          notification: { channelId: "default" },
        },
      });
    } catch (e) {
      console.error("FCM push send error:", e);
    }
  }
}

// =========================
// Read tokens for order-related notifications
// =========================
async function getTokensForOrder(orderDoc) {
  const order = orderDoc.data();
  const storeId = order?.storeId;
  const customerUid = order?.customerUid;
  const driverUid = order?.driverUid;

  const adminsSnap = await db.collection("pushTokens").where("role", "==", "admin").get();
  const adminTokens = adminsSnap.docs.map((d) => pickBestToken(d.data())).filter(Boolean);

  let ownerTokens = [];
  if (storeId) {
    const ownersSnap = await db
      .collection("pushTokens")
      .where("role", "==", "owner")
      .where("ownerStoreId", "==", storeId)
      .get();
    ownerTokens = ownersSnap.docs.map((d) => pickBestToken(d.data())).filter(Boolean);
  }

  const driversSnap = await db.collection("pushTokens").where("role", "==", "driver").get();
  const driverTokens = driversSnap.docs.map((d) => pickBestToken(d.data())).filter(Boolean);

  let assignedDriverTokens = [];
  if (driverUid) {
    const driverDoc = await db.collection("pushTokens").doc(driverUid).get();
    if (driverDoc.exists) {
      const t = pickBestToken(driverDoc.data());
      if (t) assignedDriverTokens = [t];
    }
  }

  let customerTokens = [];
  if (customerUid) {
    const custDoc = await db.collection("pushTokens").doc(customerUid).get();
    if (custDoc.exists) {
      const t = pickBestToken(custDoc.data());
      if (t) customerTokens = [t];
    }
  }

  return {
    adminTokens: unique(adminTokens),
    ownerTokens: unique(ownerTokens),
    driverTokens: unique(driverTokens),
    assignedDriverTokens: unique(assignedDriverTokens),
    customerTokens: unique(customerTokens),
    order,
  };
}

// =========================
// Typesense endpoints
// =========================
app.post(
  "/typesense/products/upsert-batch",
  verifyFirebaseToken,
  ensureAdminOrOwner,
  ensureOwnerScope,
  async (req, res) => {
    try {
      if (!typesense) {
        return res.status(500).json({ ok: false, error: "Typesense is not configured" });
      }

      const products = Array.isArray(req.body?.products) ? req.body.products : [];
      const docs = products.map(normalizeProductDoc).filter(Boolean);

      if (!docs.length) {
        return res.status(400).json({ ok: false, error: "No valid products to sync" });
      }

      const result = await typesense
        .collections(TYPESENSE_COLLECTION)
        .documents()
        .import(docs, { action: "upsert", dirty_values: "coerce_or_reject" });

      return res.json({
        ok: true,
        count: docs.length,
        result,
      });
    } catch (e) {
      console.error("/typesense/products/upsert-batch error:", e);
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }
);

app.post(
  "/typesense/products/delete-batch",
  verifyFirebaseToken,
  ensureAdminOrOwner,
  ensureOwnerScope,
  async (req, res) => {
    try {
      if (!typesense) {
        return res.status(500).json({ ok: false, error: "Typesense is not configured" });
      }

      const ids = Array.isArray(req.body?.ids)
        ? req.body.ids.map((x) => safeString(x)).filter(Boolean)
        : [];

      if (!ids.length) {
        return res.status(400).json({ ok: false, error: "No ids provided" });
      }

      const results = [];
      for (const id of ids) {
        try {
          const deleted = await typesense.collections(TYPESENSE_COLLECTION).documents(id).delete();
          results.push({ id, ok: true, deleted });
        } catch (e) {
          results.push({ id, ok: false, error: String(e?.message || e) });
        }
      }

      return res.json({ ok: true, count: ids.length, results });
    } catch (e) {
      console.error("/typesense/products/delete-batch error:", e);
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }
);

// =========================
// POST /notify/new-order
// =========================
app.post("/notify/new-order", async (req, res) => {
  try {
    const {
      orderId,
      deliveryFee: deliveryFeeFromClient,
      itemsTotal: itemsTotalFromClient,
      grandTotal: grandTotalFromClient,
    } = req.body || {};

    if (!orderId) {
      return res.status(400).json({ ok: false, error: "orderId required" });
    }

    const orderDoc = await db.collection("orders").doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ ok: false, error: "order not found" });
    }

    const { adminTokens, ownerTokens, driverTokens, order } = await getTokensForOrder(orderDoc);

    const customer = order?.customer || {};
    const storeLabel = getStoreLabel(order);
    const lineNames = getLineNames(order);

    const itemsTotal =
      itemsTotalFromClient != null ? toNumber(itemsTotalFromClient) : computeItemsTotal(order);
    const deliveryFee =
      deliveryFeeFromClient != null ? toNumber(deliveryFeeFromClient) : computeDeliveryFee(order);
    const grandTotal =
      grandTotalFromClient != null ? toNumber(grandTotalFromClient) : itemsTotal + deliveryFee;

    const titleOwner = `🛒 طلب جديد ${order?.orderNo || "#" + orderId}`;
    const bodyOwner =
      `الزبون: ${customer.fullName || "زبون"} | الهاتف: ${customer.phone || "-"} | ` +
      `الأصناف: ${lineNames}`;

    const titleAdmin = `🛎️ طلب جديد ${order?.orderNo || "#" + orderId} (لوحة الإدارة)`;
    const bodyAdmin =
      `المتجر: ${storeLabel} | الزبون: ${customer.fullName || "زبون"} | ` +
      `الإجمالي: ${grandTotal.toFixed(2)}₪`;

    const titleDriver = `🚚 طلب جديد متاح`;
    const bodyDriver = `المتجر: ${storeLabel} | الإجمالي: ${grandTotal.toFixed(2)}₪`;

    await sendPush(ownerTokens, titleOwner, bodyOwner, { type: "new_order", orderId });
    await sendPush(adminTokens, titleAdmin, bodyAdmin, { type: "new_order", orderId });
    await sendPush(driverTokens, titleDriver, bodyDriver, { type: "new_order", orderId });

    return res.json({
      ok: true,
      counts: {
        admin: adminTokens.length,
        owner: ownerTokens.length,
        driver: driverTokens.length,
        customer: 0,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// =========================
// POST /notify/customer-checkout-summary
// =========================
app.post("/notify/customer-checkout-summary", async (req, res) => {
  try {
    const {
      customerUid,
      orderIds = [],
      itemsTotal,
      deliveryFee,
      grandTotal,
      storesCount,
    } = req.body || {};

    if (!customerUid) {
      return res.status(400).json({ ok: false, error: "customerUid required" });
    }

    const customerDoc = await db.collection("pushTokens").doc(customerUid).get();
    if (!customerDoc.exists) {
      return res.status(404).json({ ok: false, error: "customer push token not found" });
    }

    const token = pickBestToken(customerDoc.data());
    if (!token) {
      return res.status(404).json({ ok: false, error: "customer token missing" });
    }

    const safeItemsTotal = toNumber(itemsTotal);
    const safeDeliveryFee = deliveryFee != null ? toNumber(deliveryFee) : 20;
    const safeGrandTotal =
      grandTotal != null ? toNumber(grandTotal) : safeItemsTotal + safeDeliveryFee;

    const count = toNumber(storesCount) || (Array.isArray(orderIds) ? orderIds.length : 1);

    const title = "✅ تم استلام طلبك";
    const body =
      `تم إنشاء ${count} طلب/طلبات بنجاح | ` +
      `قيمة المشتريات: ${safeItemsTotal.toFixed(2)}₪ | ` +
      `أجرة التوصيل: ${safeDeliveryFee.toFixed(2)}₪ | ` +
      `الإجمالي: ${safeGrandTotal.toFixed(2)}₪`;

    await sendPush([token], title, body, {
      type: "checkout_summary",
      customerUid,
      orderIds,
      itemsTotal: String(safeItemsTotal),
      deliveryFee: String(safeDeliveryFee),
      grandTotal: String(safeGrandTotal),
    });

    return res.json({ ok: true, sent: 1 });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// =========================
// POST /notify/status-change
// =========================
app.post("/notify/status-change", async (req, res) => {
  try {
    const { orderId, status, newStatus } = req.body || {};
    const finalStatus = status || newStatus;

    if (!orderId || !finalStatus) {
      return res.status(400).json({ ok: false, error: "orderId + status required" });
    }

    const orderDoc = await db.collection("orders").doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ ok: false, error: "order not found" });
    }

    const { adminTokens, ownerTokens, customerTokens, assignedDriverTokens, order } =
      await getTokensForOrder(orderDoc);

    const title = "🔄 تحديث حالة الطلب";
    const body = `الطلب: ${order?.orderNo || "#" + orderId} | الحالة الجديدة: ${finalStatus}`;

    const all = unique([
      ...adminTokens,
      ...ownerTokens,
      ...customerTokens,
      ...assignedDriverTokens,
    ]);

    await sendPush(all, title, body, {
      type: "status_change",
      orderId,
      status: finalStatus,
    });

    return res.json({
      ok: true,
      counts: {
        admin: adminTokens.length,
        owner: ownerTokens.length,
        customer: customerTokens.length,
        driver: assignedDriverTokens.length,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// =========================
// POST /notify/driver-accepted
// =========================
app.post("/notify/driver-accepted", async (req, res) => {
  try {
    const { orderId, driverUid } = req.body || {};

    if (!orderId) {
      return res.status(400).json({ ok: false, error: "orderId required" });
    }

    const orderDoc = await db.collection("orders").doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ ok: false, error: "order not found" });
    }

    const { adminTokens, ownerTokens, customerTokens, order } = await getTokensForOrder(orderDoc);

    let driverName = "السائق";
    if (driverUid) {
      try {
        const driverUserDoc = await db.collection("users").doc(driverUid).get();
        if (driverUserDoc.exists) {
          const d = driverUserDoc.data() || {};
          driverName = d.displayName || d.fullName || d.name || driverName;
        }
      } catch {}
    }

    const title = "🚚 تم استلام الطلب من السائق";
    const body = `الطلب: ${order?.orderNo || "#" + orderId} | السائق: ${driverName}`;

    const all = unique([...adminTokens, ...ownerTokens, ...customerTokens]);

    await sendPush(all, title, body, {
      type: "driver_accepted",
      orderId,
      driverUid: driverUid || "",
    });

    return res.json({
      ok: true,
      counts: {
        admin: adminTokens.length,
        owner: ownerTokens.length,
        customer: customerTokens.length,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// =========================
// POST /notify/broadcast
// =========================
app.post("/notify/broadcast", async (req, res) => {
  try {
    const { title, body, role = "all" } = req.body || {};

    if (!title || !body) {
      return res.status(400).json({ ok: false, error: "title + body required" });
    }

    let snap;
    if (role === "all") {
      snap = await db.collection("pushTokens").get();
    } else {
      snap = await db.collection("pushTokens").where("role", "==", role).get();
    }

    const tokens = unique(
      snap.docs.map((d) => pickBestToken(d.data())).filter(Boolean)
    );

    await sendPush(tokens, title, body, {
      type: "broadcast",
      role,
    });

    return res.json({ ok: true, sent: tokens.length });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// =========================
// Start server
// =========================
const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => {
  console.log("Push server running on port", port);
});