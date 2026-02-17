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
// ✅ الأفضل على Render: حط JSON كامل داخل ENV باسم FIREBASE_SERVICE_ACCOUNT_JSON
// ✅ أو استخدم ملف محلي serviceAccountKey.json (مناسب للتجارب المحلية فقط)
let serviceAccount = null;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
} else {
  const serviceAccountPathEnv = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "./serviceAccountKey.json";
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
  // إذا التطبيق صار يخزن itemsTotal مباشرة
  if (order && order.itemsTotal != null) return toNumber(order.itemsTotal);

  const lines = Array.isArray(order?.lines) ? order.lines : [];
  return lines.reduce((sum, l) => {
    const price = toNumber(l?.price);
    // ندعم عدة أسماء للكمية (qty / weightKg / kg / quantity)
    const qty =
      l?.qty != null ? toNumber(l.qty) :
      l?.weightKg != null ? toNumber(l.weightKg) :
      l?.kg != null ? toNumber(l.kg) :
      l?.quantity != null ? toNumber(l.quantity) : 1;

    return sum + price * qty;
  }, 0);
}

function computeDeliveryFee(order) {
  // إذا التطبيق صار يخزن deliveryFee
  if (order && order.deliveryFee != null) return toNumber(order.deliveryFee);
  // افتراضي حسب طلبك: 20 شيكل
  return 20;
}

function computeGrandTotal(order) {
  // إذا التطبيق صار يخزن total مباشرة نستخدمه
  if (order && order.total != null) return toNumber(order.total);

  const itemsTotal = computeItemsTotal(order);
  const delivery = computeDeliveryFee(order);
  return itemsTotal + delivery;
}



// ✅ CORS (مهم لو بتجرب من متصفح أو Web)
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
      // FCM data لازم تكون strings
      const dataStr = Object.fromEntries(
        Object.entries(data || {}).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])
      );

      await admin.messaging().sendEachForMulticast({
        tokens: fcmTokens,
        notification: { title, body },
        data: dataStr,
        android: { notification: { channelId: "orders" } },
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
  const adminTokens = adminsSnap.docs
    .map((d) => d.data()?.token || d.data()?.expoToken || d.data()?.deviceToken)
    .filter(Boolean);

  // 2) owners for this store
  let ownerTokens = [];
  if (storeId) {
    const ownersSnap = await db
      .collection("pushTokens")
      .where("role", "==", "owner")
      .where("ownerStoreId", "==", storeId)
      .get();
    ownerTokens = ownersSnap.docs
        .map((d) => d.data()?.token || d.data()?.expoToken || d.data()?.deviceToken)
        .filter(Boolean);
  }

  // 3) customer token (if exists)
  let customerTokens = [];
  if (customerUid) {
    const custDoc = await db.collection("pushTokens").doc(customerUid).get();
    if (custDoc.exists) {
      const t = custDoc.data()?.token || custDoc.data()?.expoToken || custDoc.data()?.deviceToken;
      if (t) customerTokens = [t];
    }
  }

  return { adminTokens, ownerTokens, customerTokens, order };
}

// =========================
// POST /notify/new-order
// body: { orderId }
// =========================
app.post("/notify/new-order", async (req, res) => {
  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ ok: false, error: "orderId required" });

    const orderDoc = await db.collection("orders").doc(orderId).get();
    if (!orderDoc.exists) return res.status(404).json({ ok: false, error: "order not found" });

    const { adminTokens, ownerTokens, customerTokens, order } = await getTokensForNewOrder(orderDoc);

    const customer = order?.customer || {};
    const titleOwner = `🛒 طلب جديد #${orderId}`;
    const bodyOwner = `طلب جديد من: ${customer.fullName || "زبون"} - ${customer.phone || ""}`;

    const titleAdmin = `🛎️ طلب جديد #${orderId} (لوحة الإدارة)`;
    const bodyAdmin = `محل: ${order?.storeId || "-"} | الإجمالي: ${computeGrandTotal(order).toFixed(2)}₪`;

    const titleCustomer = `✅ تم استلام طلبك #${orderId}`;

// ✅ نص الإشعار للزبون: قيمة المشتريات + توصيل 20 + الإجمالي
const itemsTotal = computeItemsTotal(order);
const deliveryFee = computeDeliveryFee(order);
const grandTotal = computeGrandTotal(order);

const bodyCustomer = `قيمة المشتريات: ${itemsTotal.toFixed(2)}₪ + توصيل: ${deliveryFee.toFixed(2)}₪ = الإجمالي: ${grandTotal.toFixed(2)}₪` + 
  ` | الحالة: ${order?.status || "جديد"}`;

    await sendPush(ownerTokens, titleOwner, bodyOwner, { type: "new_order", orderId });
    await sendPush(adminTokens, titleAdmin, bodyAdmin, { type: "new_order", orderId });
    await sendPush(customerTokens, titleCustomer, bodyCustomer, { type: "new_order", orderId });

    res.json({
      ok: true,
      counts: {
        admin: adminTokens.length,
        owner: ownerTokens.length,
        customer: customerTokens.length,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// =========================
// POST /notify/status-change
// body: { orderId, status } (أو newStatus للتوافق)
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

    // نجيب توكنات الجميع حسب نفس قواعد الطلب
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