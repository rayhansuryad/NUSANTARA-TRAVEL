import { randomInt, randomUUID } from "node:crypto";
import * as db from "./db.js";
import { charge, mapStatus } from "./midtrans.js";
import { balanceFor, computeTotal, payNowFor } from "./pricing.js";
import { validateBookingPayload } from "./validate.js";

/* No I, O, 0 or 1, so a code read off a screen or over the phone is
   unambiguous. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/* The balance order id is the deposit's code plus a suffix, so a notification
   arriving for either one can be traced back to the same booking by eye. */
const BALANCE_SUFFIX = "-BAL";

/* How many times the scheduler may try to raise one balance before it stops and
   leaves the booking for a person. */
const MAX_BALANCE_ATTEMPTS = 5;

/* A claim older than this belongs to a process that died, not to one still
   waiting on the gateway. */
const BALANCE_STALE_AFTER_MS = 15 * 60 * 1000;

/* How many days before departure the balance becomes payable. */
function balanceLeadDays() {
  const value = Number(process.env.BALANCE_LEAD_DAYS);
  return Number.isFinite(value) && value >= 0 ? value : 14;
}

export function balanceLeadCutoff(from = new Date()) {
  const cutoff = new Date(from.getTime() + balanceLeadDays() * 86400000);
  return cutoff.toISOString().slice(0, 10);
}

export function balanceStaleBefore(from = new Date()) {
  return new Date(from.getTime() - BALANCE_STALE_AFTER_MS).toISOString();
}

export function newBookingCode() {
  let out = "";
  for (let i = 0; i < 8; i += 1) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return "NT-" + out;
}

function expiryHours() {
  const value = Number(process.env.MIDTRANS_EXPIRY_HOURS);
  return Number.isFinite(value) && value > 0 ? value : 24;
}

/* We set the deadline rather than reading Midtrans's expiry_time back, because
   that field is not reliably ISO 8601 and the browser has to parse it. */
function expiryFromNow() {
  return new Date(Date.now() + expiryHours() * 3600 * 1000).toISOString();
}

function now() {
  return new Date().toISOString();
}

function isUniqueViolation(error) {
  return db.isUniqueViolation(error);
}

/*
 * The shape the browser is allowed to see. The balance is present only once it
 * has actually been raised, so a deposit booking that has not reached its lead
 * window carries no balance field at all rather than a zero one.
 */
export function publicBooking(row) {
  let payment = null;
  if (row.va_number) {
    payment = { type: "va", bank: row.bank, vaNumber: row.va_number };
  } else if (row.qr_url) {
    payment = { type: "qris", qrUrl: row.qr_url };
  }

  let balance = null;
  if (row.balance_status && row.balance_status !== "raising") {
    const instructions = {};
    if (row.balance_va_number) {
      instructions.vaNumber = row.balance_va_number;
      instructions.bank = row.balance_bank;
      instructions.type = "va";
    } else if (row.balance_qr_url) {
      instructions.qrUrl = row.balance_qr_url;
      instructions.type = "qris";
    }
    balance = {
      amount: row.balance_amount,
      status: row.balance_status,
      expiresAt: row.balance_expires_at,
      ...instructions
    };
  }

  return {
    code: row.code,
    status: row.status,
    total: row.total,
    payNow: row.amount,
    tripDate: row.trip_date || "",
    expiresAt: row.expires_at,
    payment,
    balance
  };
}

/* An attempt that produced no payment instructions is only "in flight" for a
   short while. Past that it died, and nothing was charged. */
const ABANDONED_AFTER_MS = 60_000;

/*
 * A row found by idempotency key is only reusable once it carries payment
 * instructions. Returns a response to send, or null when the key should be
 * released and this request should start fresh.
 */
async function reuseOrRelease(existing) {
  if (existing.va_number || existing.qr_url) {
    return { ok: true, status: 200, body: publicBooking(existing) };
  }

  /* Not pending means the attempt ended without payment instructions, so
     nothing was charged and the key is free again. */
  if (existing.status !== "pending") {
    await db.deleteBooking(existing.code);
    return null;
  }

  const age = Date.now() - Date.parse(existing.created_at || "");
  if (Number.isFinite(age) && age < ABANDONED_AFTER_MS) {
    return {
      ok: false,
      status: 409,
      error: "in_progress",
      message: "This booking is still being created. Try again in a moment."
    };
  }

  await db.deleteBooking(existing.code);
  return null;
}

/*
 * Two requests carrying one idempotency key should share a single result
 * rather than race. Without this, the loser can read the winner's row before
 * the gateway has answered and reply with a booking that has no way to pay.
 */
const inFlight = new Map();

export function createBooking(payload) {
  const key =
    payload && typeof payload.idempotencyKey === "string" ? payload.idempotencyKey.trim() : "";

  if (!key) return createBookingOnce(payload);

  const pending = inFlight.get(key);
  if (pending) return pending;

  const work = createBookingOnce(payload);
  inFlight.set(key, work);
  const release = () => inFlight.delete(key);
  work.then(release, release);
  return work;
}

/*
 * Creates the booking, then the gateway transaction.
 *
 * The row goes in first so the idempotency key is reserved before any money
 * moves. Two concurrent submits with the same key can then never produce two
 * virtual accounts: the second one loses the race and gets the first result.
 */
async function createBookingOnce(payload) {
  const checked = validateBookingPayload(payload);
  if (!checked.ok) {
    return { ok: false, status: 400, error: "invalid", errors: checked.errors };
  }

  const input = checked.value;
  const quote = computeTotal({
    packageId: input.packageId,
    participants: input.participants,
    accommodationId: input.accommodationId,
    addons: input.addons
  });

  if (!quote) {
    return { ok: false, status: 400, error: "invalid", message: "Cannot price this selection" };
  }

  const amount = payNowFor(quote.total, input.paymentType);

  /* The browser told us what it displayed. If it disagrees, prices moved while
     the page was open, so refuse rather than charge a number nobody saw. */
  if (
    Number.isFinite(input.expectedTotal) &&
    Math.round(input.expectedTotal) !== quote.total
  ) {
    return {
      ok: false,
      status: 409,
      error: "pricing_changed",
      message: "The displayed total no longer matches the current price list"
    };
  }
  if (
    Number.isFinite(input.expectedPayNow) &&
    Math.round(input.expectedPayNow) !== amount
  ) {
    return {
      ok: false,
      status: 409,
      error: "pricing_changed",
      message: "The displayed amount no longer matches the current price list"
    };
  }

  const existing = await db.getBookingByIdempotencyKey(input.idempotencyKey);
  if (existing) {
    const settled = await reuseOrRelease(existing);
    if (settled) return settled;
  }

  const timestamp = now();
  const code = newBookingCode();

  const row = {
    code,
    idempotency_key: input.idempotencyKey,
    package_id: input.packageId,
    participants: input.participants,
    accommodation_id: input.accommodationId,
    addon_ids: input.addons.join(","),
    payment_type: input.paymentType,
    method: input.method,
    trip_date: input.date,
    total: quote.total,
    amount,
    name: input.name,
    email: input.email,
    phone: input.phone,
    notes: input.notes,
    gateway: "midtrans",
    gateway_order_id: code,
    gateway_transaction_id: "",
    status: "pending",
    va_number: "",
    bank: "",
    qr_url: "",
    expires_at: expiryFromNow(),
    created_at: timestamp,
    paid_at: "",
    updated_at: timestamp,
    /* Recorded now, raised later, once the deposit is actually paid. */
    balance_amount: balanceFor(quote.total, input.paymentType),
    balance_status: "",
    balance_gateway_order_id: null,
    balance_va_number: "",
    balance_bank: "",
    balance_qr_url: "",
    balance_expires_at: "",
    balance_raised_at: "",
    balance_paid_at: "",
    balance_attempts: 0
  };

  let stored;
  try {
    stored = await db.insertBooking(row);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    /* Lost the race against a request on another instance. Return whatever
       that one produced, or say to wait if it is still charging. */
    const winner = await db.getBookingByIdempotencyKey(input.idempotencyKey);
    if (!winner) throw error;
    return (
      (await reuseOrRelease(winner)) || {
        ok: false,
        status: 409,
        error: "in_progress",
        message: "This booking is still being created. Try again in a moment."
      }
    );
  }

  try {
    const result = await charge({
      orderId: stored.code,
      amount,
      method: input.method,
      expiryHours: expiryHours(),
      customer: { name: input.name, email: input.email, phone: input.phone }
    });

    stored = await db.updateBooking(code, {
      gateway_transaction_id: result.transactionId,
      va_number: result.payment.vaNumber || "",
      bank: result.payment.bank || "",
      qr_url: result.payment.qrUrl || "",
      updated_at: now()
    });
  } catch (error) {
    /* No payment instructions exist, so the booking cannot be paid. Record that
       instead of leaving a pending row that will never resolve. */
    stored = await db.updateBooking(code, { status: "failed", updated_at: now() });
    return {
      ok: false,
      status: 502,
      error: "gateway_unavailable",
      code,
      message: "The payment provider did not accept this transaction"
    };
  }

  return { ok: true, status: 201, body: publicBooking(stored) };
}

/*
 * A payment window that closed with no notification would otherwise sit at
 * pending forever. The client counts down locally too; this covers a reload.
 */
function withLocalExpiry(row) {
  if (!row || row.status !== "pending" || !row.expires_at) return row;
  const deadline = Date.parse(row.expires_at);
  if (!Number.isFinite(deadline)) return row;
  /* Give the webhook a window to land before overriding what the gateway said. */
  if (Date.now() - deadline < 15 * 60 * 1000) return row;
  return { ...row, status: "expired" };
}

/* Same reasoning for the balance: a window that closed with no notification
   must not keep reading as payable. */
function withBalanceLocalExpiry(row) {
  if (!row || row.balance_status !== "pending" || !row.balance_expires_at) return row;
  const deadline = Date.parse(row.balance_expires_at);
  if (!Number.isFinite(deadline)) return row;
  if (Date.now() - deadline < 15 * 60 * 1000) return row;
  return { ...row, balance_status: "expired" };
}

export async function getPublicBooking(code) {
  const row = await db.getBooking(code);
  if (!row) return null;
  return publicBooking(withBalanceLocalExpiry(withLocalExpiry(row)));
}

/*
 * Whether a notification may move a booking, shared by the deposit and the
 * balance because the rules are the same for both.
 *
 * Deliberately conservative about moving backwards, because notifications
 * arrive out of order and repeat: a late "pending" must not unpay a booking.
 * A booking that already expired or failed can still be settled later, which is
 * what a late settlement looks like.
 */
function resolveTransition(current, next) {
  if (next === current) return null;
  /* Paid is final, except for a refund. */
  if (current === "paid" && next !== "refunded") return null;
  /* Nothing follows a refund. */
  if (current === "refunded") return null;
  return next;
}

function alreadyCurrent(row, orderId) {
  return Boolean(row.balance_gateway_order_id) && row.balance_gateway_order_id === orderId;
}

/*
 * Applies a gateway notification to whichever payment it belongs to. A booking
 * has two order ids once a balance is raised, and the notification carries no
 * hint which, so it is matched against both.
 */
export async function applyNotification({ orderId, transactionStatus, fraudStatus }) {
  const row = await db.getBookingByAnyOrderId(orderId);
  if (!row) return { ok: true, changed: false, reason: "unknown_order" };

  const next = mapStatus(transactionStatus, fraudStatus);
  if (!next) return { ok: true, changed: false, reason: "unknown_status" };

  const balance = alreadyCurrent(row, orderId);
  const current = balance ? row.balance_status : row.status;
  /* A balance that was never actually raised cannot be settled by a stray
     notification. */
  if (balance && !current) return { ok: true, changed: false, reason: "balance_not_raised" };

  const decided = resolveTransition(current, next);
  if (!decided) {
    return { ok: true, changed: false, reason: next === current ? "already_current" : "no_backwards_move" };
  }

  const timestamp = now();
  const fields = { updated_at: timestamp };
  if (balance) {
    fields.balance_status = decided;
    if (decided === "paid" && !row.balance_paid_at) fields.balance_paid_at = timestamp;
  } else {
    fields.status = decided;
    if (decided === "paid" && !row.paid_at) fields.paid_at = timestamp;
  }

  await db.updateBooking(row.code, fields);
  return { ok: true, changed: true, target: balance ? "balance" : "deposit", status: decided };
}

/* Only meaningful for the deposit: a paid deposit is what triggers the balance.
   Exported so the status path and the cron agree on the meaning of "paid". */
export function depositSettled(row) {
  return Boolean(row) && row.payment_type === "dp" && row.status === "paid";
}

/*
 * Raises the balance for a deposit booking whose trip is close enough. The
 * deposit has to be paid first: invoicing a balance before the deposit lands
 * would put a second live account in front of a customer who has paid nothing.
 */
export async function raiseBalance(row) {
  if (!row) return { ok: false, reason: "missing_booking" };
  if (row.payment_type !== "dp") return { ok: false, reason: "not_a_deposit" };
  if (row.status !== "paid") return { ok: false, reason: "deposit_not_paid" };
  if (!row.trip_date) return { ok: false, reason: "no_trip_date" };
  /* "raising" is a claim in progress. A stale one is claimable again, which is
     how a raise abandoned by a dead process gets finished. */
  if (row.balance_status && row.balance_status !== "raising") {
    return { ok: false, reason: "already_raised" };
  }
  if (!(row.balance_amount > 0)) return { ok: false, reason: "nothing_owed" };

  /* The attempt counter lives on the row, so a retry after a transient failure
     reuses the same order id and lets the gateway's own order-id uniqueness
     help. A permanent failure stops at the ceiling instead of looping forever. */
  const orderId = row.code + BALANCE_SUFFIX;
  const stamp = now();
  const claimed = await db.claimBalance(
    row.code,
    orderId,
    stamp,
    MAX_BALANCE_ATTEMPTS,
    balanceStaleBefore()
  );
  if (!claimed) return { ok: false, reason: "not_claimed" };

  let result;
  try {
    result = await charge({
      orderId,
      amount: row.balance_amount,
      method: row.method,
      expiryHours: expiryHours(),
      customer: { name: row.name, email: row.email, phone: row.phone }
    });
  } catch (error) {
    /* Nothing to pay yet, so hand the claim back and let the next run retry. */
    await db.releaseBalance(row.code, now());
    return {
      ok: false,
      reason: "gateway_error",
      message: String((error && error.message) || error)
    };
  }

  const updated = await db.updateBooking(row.code, {
    balance_status: "pending",
    balance_gateway_order_id: orderId,
    balance_va_number: result.payment.vaNumber || "",
    balance_bank: result.payment.bank || "",
    balance_qr_url: result.payment.qrUrl || "",
    balance_expires_at: expiryFromNow(),
    balance_raised_at: stamp,
    updated_at: now()
  });

  return { ok: true, booking: updated };
}

export function notificationEventId() {
  return randomUUID();
}
