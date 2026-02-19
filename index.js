import express from "express";
import admin from "firebase-admin";
import { Expo } from "expo-server-sdk";
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

function pickBestToken(doc) {
  const d = doc || {};
  if (typeof d.deviceToken === "string" && d.deviceToken.length > 20) return d.deviceToken;
  if (typeof d.fcmToken === "string" && d.fcmToken.length > 20) return d.fcmToken;
  if (d.tokenType === "fcm" && typeof d.token === "string" && d.token.length > 20) return d.token;
  if (typeof d.expoToken === "string") return d.expoToken;
  if (typeof d.token === "string") return d.token;
  return null;
}

function isExpoToken(t) {
  return typeof t === "string" && t.startsWith("ExponentPushToken[");
}

const app = express();

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
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

/**
 * ✅ مهم: لو order.total موجود لكنه بدون توصيل، نحسب نحن.
 * - إذا order.total + order.deliveryFee موجودين: نستخدم total كما هو.
 * - غير هيك: itemsTotal + deliveryFee
 */
function computeGrandTotal(order) {
  const delivery = computeDeliveryFee(order);

  if (order && order.total != null && order.deliveryFee != null) {
    return toNumber(order.total);
  }

  const itemsTotal = computeItemsTotal(order);
  return itemsTotal + delivery;
}

// ✅ CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

// ✅ Health check
app.get("/health", (_req, res) => {
  res.json({ ok: true, message: "Push server is running" });
});

// =========================
// Send push (Expo + FCM)
// =========================
async function sendPush(tokens, title, body, data = {}) {
  const expoTokens = (tokens || []).filter((t) => isExpoToken(t));
  const fcmTokens = (tokens || []).filter((t) => t && !isExpoToken(t));

  // 1) Expo
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

  // 2) FCM
  if (fcmTokens.length) {
    try {
      const dataStr = Object.fromEntries(
        Object.entries(data || {}).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])
      );

      await admin.messaging().sendEachForMulticast({
        tokens: fcmTokens,
        notification: { title, body },
        data: dataStr,
        android: { priority: "high", notification: { channelId: "default" } },
      });
    } catch (e) {
      console.error("FCM push send error:", e);
    }
  }
}

// =========================
// Read tokens for new order
// =========================
async function getTokensForNewOrder(orderDoc) {
  const order = orderDoc.data();
  const storeId = order?.storeId;
  const customerUid = order?.customerUid;

  // 1) admins
  const adminsSnap = await db.collection("pushTokens").where("role", "==", "admin").get();
  const adminTokens = adminsSnap.docs.map((d) => pickBestToken(d.data())).filter(Boolean);

  // 2) owners for this store
  let ownerTokens = [];
  if (storeId) {
    const ownersSnap = await db
      .collection("pushTokens")
      .where("role", "==", "owner")
      .where("ownerStoreId", "==", storeId)
      .get();
    ownerTokens = ownersSnap.docs.map((d) => pickBestToken(d.data())).filter(Boolean);
  }

  // 3) customer token
  let customerTokens = [];
  if (customerUid) {
    const custDoc = await db.collection("pushTokens").doc(customerUid).get();
    if (custDoc.exists) {
      const t = pickBestToken(custDoc.data());
      if (t) customerTokens = [t];
    }
  }

  return { adminTokens, ownerTokens, customerTokens, order };
}

// =========================
// POST /notify/new-order
// body: { orderId, deliveryFee?, itemsTotal?, grandTotal? }
// =========================
app.post("/notify/new-order", async (req, res) => {
  try {
    const { orderId, deliveryFee: deliveryFeeFromClient, itemsTotal: itemsTotalFromClient, grandTotal: grandTotalFromClient } =
      req.body || {};

    if (!orderId) return res.status(400).json({ ok: false, error: "orderId required" });

    const orderDoc = await db.collection("orders").doc(orderId).get();
    if (!orderDoc.exists) return res.status(404).json({ ok: false, error: "order not found" });

    const { adminTokens, ownerTokens, customerTokens, order } = await getTokensForNewOrder(orderDoc);

    const customer = order?.customer || {};
    const titleOwner = `🛒 طلب جديد #${orderId}`;
    const bodyOwner = `طلب جديد من: ${customer.fullName || "زبون"} - ${customer.phone || ""}`;

    // ✅ استخدم قيم التطبيق إن وُجدت، وإلا احسب من Firestore
    const itemsTotal = (itemsTotalFromClient != null) ? toNumber(itemsTotalFromClient) : computeItemsTotal(order);
    const deliveryFee = (deliveryFeeFromClient != null) ? toNumber(deliveryFeeFromClient) : computeDeliveryFee(order);
    const grandTotal =
      (grandTotalFromClient != null) ? toNumber(grandTotalFromClient) : (itemsTotal + deliveryFee);

    const titleAdmin = `🛎️ طلب جديد #${orderId} (لوحة الإدارة)`;
    const bodyAdmin = `محل: ${order?.storeId || "-"} | الإجمالي: ${grandTotal.toFixed(2)}₪`;

    const titleCustomer = `✅ تم استلام طلبك #${orderId}`;

    // ✅ سطر واحد عشان يبان أكيد على أندرويد
    const bodyCustomer =
      `قيمة المشتريات: ${itemsTotal.toFixed(2)}₪ | ` +
      `أجار التوصيل: ${deliveryFee.toFixed(2)}₪ | ` +
      `الإجمالي: ${grandTotal.toFixed(2)}₪ | ` +
      `الحالة: ${order?.status || "جديد"}`;

    await sendPush(ownerTokens, titleOwner, bodyOwner, { type: "new_order", orderId });
    await sendPush(adminTokens, titleAdmin, bodyAdmin, { type: "new_order", orderId });
    await sendPush(customerTokens, titleCustomer, bodyCustomer, { type: "new_order", orderId });

    res.json({
      ok: true,
      counts: { admin: adminTokens.length, owner: ownerTokens.length, customer: customerTokens.length },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
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
    if (!orderDoc.exists) return res.status(404).json({ ok: false, error: "order not found" });

    const { adminTokens, ownerTokens, customerTokens } = await getTokensForNewOrder(orderDoc);

    const title = "🔄 تحديث حالة الطلب";
    const body = `رقم الطلب: ${orderId} | الحالة الجديدة: ${finalStatus}`;

    const all = [...adminTokens, ...ownerTokens, ...customerTokens];
    await sendPush(all, title, body, { type: "status_change", orderId, status: finalStatus });

    res.json({ ok: true, counts: { admin: adminTokens.length, owner: ownerTokens.length, customer: customerTokens.length } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => console.log("Push server running on port", port));
