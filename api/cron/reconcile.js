import {
  applyNotification,
  balanceLeadCutoff,
  balanceStaleBefore,
  raiseBalance
} from "../../lib/booking.js";
import * as db from "../../lib/db.js";
import { sendJson } from "../../lib/http.js";
import { fetchStatus, mapStatus } from "../../lib/midtrans.js";
import { notifyBalanceRaised } from "../../lib/notify.js";

/*
 * Two jobs that both need the gateway and neither is urgent enough for its own
 * trigger:
 *
 *   1. Safety net for notifications that never arrived. A booking sitting at
 *      pending is asked about directly.
 *   2. Raise the balance for deposit bookings whose trip is inside the lead
 *      window, then tell the customer how to pay it.
 *
 * Vercel sends "Authorization: Bearer $CRON_SECRET" automatically when
 * CRON_SECRET is set.
 *
 * On the Hobby plan crons run once a day, which is fine for the balance and
 * loose for the reconcile. Point an uptime pinger at this URL hourly if that lag
 * matters.
 */
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET || "";
  const header = String(req.headers["authorization"] || "");
  const provided =
    header.replace(/^Bearer\s+/i, "").trim() || String(req.headers["x-cron-secret"] || "");

  if (!secret || provided !== secret) {
    return sendJson(res, 401, { error: "unauthorized" });
  }

  const reconcile = await reconcileStale();
  const balances = await raiseDueBalances();

  return sendJson(res, 200, {
    checked: reconcile.checked,
    results: reconcile.results,
    balancesChecked: balances.checked,
    balances: balances.results
  });
}

async function reconcileStale() {
  /* Only look at bookings untouched for half an hour: anything more recent is
     probably still waiting on its own notification. */
  const olderThan = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const stale = await db.listUnsettledBefore(olderThan, 25);
  const results = [];

  for (const row of stale) {
    const orderId = row.gateway_order_id || row.code;
    try {
      const status = await fetchStatus(orderId);
      const next = mapStatus(status.transactionStatus, status.fraudStatus);

      if (!next) {
        results.push({ code: row.code, gateway: status.transactionStatus, applied: null });
        continue;
      }

      const after = await db.getBooking(row.code);
      if (after && Number(status.grossAmount) !== Number(after.amount)) {
        results.push({ code: row.code, applied: null, reason: "amount_mismatch" });
        continue;
      }

      const result = await applyNotification({
        orderId: row.code,
        transactionStatus: status.transactionStatus,
        fraudStatus: status.fraudStatus
      });
      results.push({
        code: row.code,
        gateway: status.transactionStatus,
        applied: result.changed ? result.status : null,
        reason: result.reason
      });
    } catch (error) {
      results.push({ code: row.code, error: error.message });
    }
  }

  return { checked: stale.length, results };
}

async function raiseDueBalances() {
  /* Trip date on or before today plus the lead days, plus any raise that a dead
     process left half finished. */
  const due = await db.listBalancesDue(balanceLeadCutoff(), balanceStaleBefore(), 25);
  const results = [];

  for (const row of due) {
    try {
      const outcome = await raiseBalance(row);
      if (!outcome.ok) {
        results.push({ code: row.code, raised: false, reason: outcome.reason });
        continue;
      }

      const notice = await notifyBalanceRaised(outcome.booking);
      results.push({
        code: row.code,
        raised: true,
        amount: outcome.booking.balance_amount,
        notified: notice.delivered,
        notice: notice.reason
      });
    } catch (error) {
      results.push({ code: row.code, raised: false, error: error.message });
    }
  }

  return { checked: due.length, results };
}
