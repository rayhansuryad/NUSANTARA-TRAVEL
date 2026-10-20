import { applyNotification, notificationEventId } from "../../lib/booking.js";
import * as db from "../../lib/db.js";
import { readJson, sendJson } from "../../lib/http.js";
import { verifySignature } from "../../lib/midtrans.js";

/*
 * Midtrans posts here. Configure this URL as the Payment Notification URL in
 * the Midtrans dashboard.
 *
 * Two rules shape everything below:
 *   1. Anyone can POST to this route, so the signature decides whether we act.
 *   2. Midtrans retries, so every outcome is answered 200 unless we want a
 *      retry. Refusing to move a booking is not something a retry can fix.
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "POST" });
  }

  let payload;
  try {
    payload = await readJson(req);
  } catch (error) {
    /* A body we cannot parse will never parse on a retry either. */
    return sendJson(res, 200, { ok: false, ignored: "unreadable_body" });
  }

  const orderId = String(payload.order_id || "");
  const statusCode = String(payload.status_code || "");
  const grossAmount = String(payload.gross_amount || "");
  const transactionStatus = String(payload.transaction_status || "");
  const transactionId = String(payload.transaction_id || "");

  const signatureOk = verifySignature({
    orderId,
    statusCode,
    grossAmount,
    signatureKey: payload.signature_key
  });

  /* Record every attempt, including rejected ones. When a payment goes missing
     at midnight this table is the only way to see what actually arrived. */
  try {
    await db.insertWebhookEvent({
      id: notificationEventId(),
      orderId,
      transactionId,
      transactionStatus,
      signatureOk,
      raw: JSON.stringify(payload).slice(0, 4000),
      receivedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error("Could not record the webhook event:", error);
  }

  if (!signatureOk) {
    console.warn("Rejected a Midtrans notification with an invalid signature for", orderId);
    return sendJson(res, 403, { error: "bad_signature" });
  }

  const booking = await db.getBookingByAnyOrderId(orderId);
  if (!booking) {
    /* Not ours. Retrying will not conjure the order. */
    return sendJson(res, 200, { ok: true, ignored: "unknown_order" });
  }

  /* A booking with a raised balance has two live order ids, and the amount to
     expect depends on which one this notification is about. */
  const isBalance =
    Boolean(booking.balance_gateway_order_id) && booking.balance_gateway_order_id === orderId;
  const expected = isBalance ? booking.balance_amount : booking.amount;

  /* The signature already proves Midtrans sent this, but not that it was for
     this transaction. Compare the amount against our own record as well. */
  if (Number(grossAmount) !== Number(expected)) {
    console.error(
      `Amount mismatch for ${orderId}: gateway said ${grossAmount}, we expected ${expected}`
    );
    return sendJson(res, 200, { ok: true, ignored: "amount_mismatch" });
  }

  const result = await applyNotification({
    orderId,
    transactionStatus,
    fraudStatus: String(payload.fraud_status || "")
  });

  return sendJson(res, 200, { ok: true, ...result });
}
