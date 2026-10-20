import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";

process.env.MIDTRANS_ENV = "sandbox";
process.env.MIDTRANS_SERVER_KEY = "SB-Mid-server-TESTKEY";
process.env.MIDTRANS_BANK = "bca";
process.env.MIDTRANS_EXPIRY_HOURS = "24";
process.env.SQLITE_PATH = ":memory:";
process.env.CRON_SECRET = "test-cron-secret";
process.env.DATABASE_URL = "";
/* The fixtures here create far more bookings per minute than a real visitor,
   so the production ceiling would throttle the suite itself. The limiter has
   its own test below. */
process.env.BOOKING_RATE_LIMIT = "1000";

const { createApp, listen } = await import("../server/app.js");
const { startMockGateway } = await import("../server/mock-midtrans.js");
const db = await import("../lib/db.js");

let app;
let mock;
let appBase;

function tomorrow() {
  return new Date(Date.now() + 86400000).toISOString().slice(0, 10);
}

let keyCounter = 0;
function payload(overrides = {}) {
  keyCounter += 1;
  return {
    packageId: "borobudur",
    accommodationId: "star3",
    paymentType: "dp",
    method: "va",
    date: tomorrow(),
    participants: 2,
    name: "Budi Santoso",
    email: "budi@example.com",
    phone: "081234567890",
    notes: "",
    addonIds: [],
    expectedTotal: 3700000,
    expectedPayNow: 1110000,
    idempotencyKey: `test-key-${String(keyCounter).padStart(6, "0")}`,
    ...overrides
  };
}

async function post(path, body) {
  const response = await fetch(appBase + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function get(path) {
  const response = await fetch(appBase + path);
  return { status: response.status, body: await response.json().catch(() => null) };
}

before(async () => {
  app = createApp();
  const appPort = await listen(app, 0);
  appBase = `http://127.0.0.1:${appPort}`;

  mock = await startMockGateway({
    port: 0,
    appBase,
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    bank: "bca"
  });
  /* Must be set before the first charge call, not before the first import. */
  process.env.MIDTRANS_API_BASE = `http://127.0.0.1:${mock.port}`;
});

after(async () => {
  await mock.close();
  await new Promise((done) => app.close(done));
  await db.close();
});

test("a booking is created, priced by the server, and gets a virtual account", async () => {
  const result = await post("/api/bookings", payload());

  assert.equal(result.status, 201);
  assert.match(result.body.code, /^NT-[A-Z0-9]{8}$/);
  assert.equal(result.body.status, "pending");
  assert.equal(result.body.total, 3700000);
  assert.equal(result.body.payNow, 1110000);
  assert.equal(result.body.payment.type, "va");
  assert.equal(result.body.payment.bank, "bca");
  assert.match(result.body.payment.vaNumber, /^\d+$/);
  assert.ok(Date.parse(result.body.expiresAt) > Date.now());
});

test("QRIS returns a QR image instead of an account number", async () => {
  const result = await post("/api/bookings", payload({ method: "qris", expectedPayNow: 1110000 }));
  assert.equal(result.status, 201);
  assert.equal(result.body.payment.type, "qris");
  assert.match(result.body.payment.qrUrl, /^http/);
  assert.equal(result.body.payment.vaNumber, undefined);
});

test("a Permata account comes from the permata_va_number field", async () => {
  /* Permata replies with one top-level field instead of a va_numbers list, so
     this runs against a second mock that mirrors that shape. */
  const permata = await startMockGateway({
    port: 0,
    appBase,
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    bank: "permata"
  });

  const previousBase = process.env.MIDTRANS_API_BASE;
  const previousBank = process.env.MIDTRANS_BANK;
  process.env.MIDTRANS_API_BASE = `http://127.0.0.1:${permata.port}`;
  process.env.MIDTRANS_BANK = "permata";
  try {
    const result = await post("/api/bookings", payload({ expectedPayNow: 1110000 }));
    assert.equal(result.status, 201);
    assert.equal(result.body.payment.type, "va");
    assert.equal(result.body.payment.bank, "permata");
    assert.match(result.body.payment.vaNumber, /^\d+$/);
  } finally {
    process.env.MIDTRANS_API_BASE = previousBase;
    process.env.MIDTRANS_BANK = previousBank;
    await permata.close();
  }
});

test("a stale total is refused rather than charged", async () => {
  const result = await post("/api/bookings", payload({ expectedTotal: 999 }));
  assert.equal(result.status, 409);
  assert.equal(result.body.error, "pricing_changed");
});

test("a stale amount is refused even when the total matches", async () => {
  const result = await post("/api/bookings", payload({ expectedPayNow: 1 }));
  assert.equal(result.status, 409);
  assert.equal(result.body.error, "pricing_changed");
});

test("unsupported payment methods are rejected", async () => {
  const result = await post("/api/bookings", payload({ method: "card" }));
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "invalid");
  assert.ok(result.body.errors.method);
});

test("the same idempotency key never creates a second virtual account", async () => {
  const request = payload({ idempotencyKey: "fixed-key-for-replay" });

  const first = await post("/api/bookings", request);
  const second = await post("/api/bookings", request);

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.code, first.body.code);
  assert.equal(second.body.payment.vaNumber, first.body.payment.vaNumber);
});

test("different idempotency keys produce different bookings", async () => {
  const first = await post("/api/bookings", payload());
  const second = await post("/api/bookings", payload());
  assert.notEqual(first.body.code, second.body.code);
});

test("two concurrent submits with one key produce exactly one booking", async () => {
  const shared = payload({ idempotencyKey: "concurrent-key-0001" });
  const [left, right] = await Promise.all([
    post("/api/bookings", shared),
    post("/api/bookings", shared)
  ]);

  /* Not just the same code: the same response, payment instructions included.
     A duplicate that replies without the account number leaves the customer
     staring at a booking they cannot pay. */
  assert.deepEqual(right.body, left.body);
  assert.equal(left.status, 201);
  assert.ok(left.body.payment.vaNumber);
});

test("a booking attempt that died before payment can reuse its key", async () => {
  const request = payload({ idempotencyKey: "dead-attempt-key-01" });
  const first = await post("/api/bookings", request);
  assert.equal(first.status, 201);

  /* Simulate the earlier attempt stopping between the insert and the gateway
     call: a pending row with no payment instructions, older than the grace
     window. */
  await db.updateBooking(first.body.code, {
    va_number: "",
    bank: "",
    created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString()
  });

  const retry = await post("/api/bookings", request);
  assert.equal(retry.status, 201);
  assert.notEqual(retry.body.code, first.body.code);
  assert.ok(retry.body.payment.vaNumber);
});

test("a duplicate arriving mid-flight is told to wait, not given a blank booking", async () => {
  const request = payload({ idempotencyKey: "mid-flight-key-0001" });
  const first = await post("/api/bookings", request);
  assert.equal(first.status, 201);

  /* Same situation as above but still inside the grace window. */
  await db.updateBooking(first.body.code, {
    va_number: "",
    bank: "",
    created_at: new Date().toISOString()
  });

  const duplicate = await post("/api/bookings", request);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error, "in_progress");
});

test("the booking endpoint throttles a flood and then recovers", async () => {
  process.env.BOOKING_RATE_LIMIT = "3";
  try {
    const results = [];
    for (let i = 0; i < 5; i += 1) {
      /* A distinct fake IP each run would dodge the limiter, so use one. */
      const response = await fetch(appBase + "/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.7" },
        body: JSON.stringify(payload())
      });
      results.push(response.status);
    }

    assert.deepEqual(results.slice(0, 3), [201, 201, 201]);
    assert.deepEqual(results.slice(3), [429, 429]);
  } finally {
    process.env.BOOKING_RATE_LIMIT = "1000";
  }
});

test("status lookup reports the stored state and nothing private", async () => {
  const created = await post("/api/bookings", payload());
  const status = await get(`/api/bookings/status?code=${created.body.code}`);

  assert.equal(status.status, 200);
  assert.equal(status.body.status, "pending");
  assert.equal(status.body.payNow, 1110000);
  assert.equal(status.body.name, undefined);
  assert.equal(status.body.email, undefined);
  assert.equal(status.body.phone, undefined);
  assert.equal(status.body.notes, undefined);
});

test("status lookup refuses a malformed code and reports an unknown one", async () => {
  assert.equal((await get("/api/bookings/status?code=nope")).status, 400);
  assert.equal((await get("/api/bookings/status?code=NT-ZZZZZZZZ")).status, 404);
});

test("a settlement notification moves the booking to paid", async () => {
  const created = await post("/api/bookings", payload());
  const code = created.body.code;

  const settled = await fetch(`http://127.0.0.1:${mock.port}/settle?order=${code}&status=settlement`);
  assert.equal(settled.status, 200);

  const status = await get(`/api/bookings/status?code=${code}`);
  assert.equal(status.body.status, "paid");
});

test("a repeated notification is harmless", async () => {
  const created = await post("/api/bookings", payload());
  const code = created.body.code;

  await fetch(`http://127.0.0.1:${mock.port}/settle?order=${code}&status=settlement&times=3`);

  const status = await get(`/api/bookings/status?code=${code}`);
  assert.equal(status.body.status, "paid");
});

test("a paid booking is not dragged backwards by a late pending notification", async () => {
  const created = await post("/api/bookings", payload());
  const code = created.body.code;

  await fetch(`http://127.0.0.1:${mock.port}/settle?order=${code}&status=settlement`);

  /* Send a stale pending notification by hand, correctly signed, as a retry
     of an older status would be. */
  const { createHash } = await import("node:crypto");
  const amount = "1110000.00";
  const signature = createHash("sha512")
    .update(code + "200" + amount + process.env.MIDTRANS_SERVER_KEY)
    .digest("hex");

  const late = await post("/api/webhooks/midtrans", {
    order_id: code,
    status_code: "200",
    gross_amount: amount,
    transaction_status: "pending",
    transaction_id: "late-1",
    signature_key: signature
  });

  assert.equal(late.status, 200);
  assert.equal(late.body.changed, false);
  assert.equal((await get(`/api/bookings/status?code=${code}`)).body.status, "paid");
});

test("an expiry notification is recorded", async () => {
  const created = await post("/api/bookings", payload());
  const code = created.body.code;
  await fetch(`http://127.0.0.1:${mock.port}/settle?order=${code}&status=expire`);
  assert.equal((await get(`/api/bookings/status?code=${code}`)).body.status, "expired");
});

test("a forged signature is rejected and changes nothing", async () => {
  const created = await post("/api/bookings", payload());
  const code = created.body.code;

  const forged = await post("/api/webhooks/midtrans", {
    order_id: code,
    status_code: "200",
    gross_amount: "1110000.00",
    transaction_status: "settlement",
    transaction_id: "forged-1",
    signature_key: "0".repeat(128)
  });

  assert.equal(forged.status, 403);
  assert.equal(forged.body.error, "bad_signature");
  assert.equal((await get(`/api/bookings/status?code=${code}`)).body.status, "pending");
});

test("a correctly signed notification for the wrong amount is ignored", async () => {
  const created = await post("/api/bookings", payload());
  const code = created.body.code;

  const { createHash } = await import("node:crypto");
  const wrongAmount = "999.00";
  const signature = createHash("sha512")
    .update(code + "200" + wrongAmount + process.env.MIDTRANS_SERVER_KEY)
    .digest("hex");

  const result = await post("/api/webhooks/midtrans", {
    order_id: code,
    status_code: "200",
    gross_amount: wrongAmount,
    transaction_status: "settlement",
    transaction_id: "wrong-amount-1",
    signature_key: signature
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.ignored, "amount_mismatch");
  assert.equal((await get(`/api/bookings/status?code=${code}`)).body.status, "pending");
});

test("a signature valid for a different order does not move this one", async () => {
  const target = await post("/api/bookings", payload());
  const other = await post("/api/bookings", payload());

  const { createHash } = await import("node:crypto");
  /* Signature computed over the other order id, replayed against the target. */
  const signature = createHash("sha512")
    .update(other.body.code + "200" + "1110000.00" + process.env.MIDTRANS_SERVER_KEY)
    .digest("hex");

  const result = await post("/api/webhooks/midtrans", {
    order_id: target.body.code,
    status_code: "200",
    gross_amount: "1110000.00",
    transaction_status: "settlement",
    transaction_id: "cross-1",
    signature_key: signature
  });

  assert.equal(result.status, 403);
  assert.equal((await get(`/api/bookings/status?code=${target.body.code}`)).body.status, "pending");
});

test("an unreadable webhook body is acknowledged so it stops retrying", async () => {
  const response = await post("/api/webhooks/midtrans", "{not json");
  assert.equal(response.status, 200);
  assert.equal(response.body.ignored, "unreadable_body");
});

test("the reconcile cron requires its secret and then runs", async () => {
  const denied = await get("/api/cron/reconcile");
  assert.equal(denied.status, 401);

  const allowed = await fetch(appBase + "/api/cron/reconcile", {
    headers: { "x-cron-secret": process.env.CRON_SECRET }
  });
  assert.equal(allowed.status, 200);
  const body = await allowed.json();
  assert.equal(typeof body.checked, "number");
});

test("the reconcile cron repairs a booking whose notification was lost", async () => {
  const created = await post("/api/bookings", payload());
  const code = created.body.code;

  /* Settle at the gateway without telling the application. */
  mock.transactions.get(code).transaction_status = "settlement";
  mock.transactions.get(code).status_code = "200";

  /* Backdate it so the cron considers it stale. */
  await db.updateBooking(code, { updated_at: new Date(Date.now() - 3600 * 1000).toISOString() });
  assert.equal((await get(`/api/bookings/status?code=${code}`)).body.status, "pending");

  const response = await fetch(appBase + "/api/cron/reconcile", {
    headers: { "x-cron-secret": process.env.CRON_SECRET }
  });
  const body = await response.json();
  assert.ok(body.results.some((row) => row.code === code && row.applied === "paid"));

  assert.equal((await get(`/api/bookings/status?code=${code}`)).body.status, "paid");
});

/* --- the deposit balance --- */

function tripIn(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

async function runCron() {
  const response = await fetch(appBase + "/api/cron/reconcile", {
    headers: { "x-cron-secret": process.env.CRON_SECRET }
  });
  return { status: response.status, body: await response.json() };
}

/* Midtrans signs order_id + status_code + gross_amount + server key. */
function signatureFor(orderId, statusCode, grossAmount) {
  return createHash("sha512")
    .update(String(orderId) + String(statusCode) + String(grossAmount) +
      process.env.MIDTRANS_SERVER_KEY)
    .digest("hex");
}

/* A deposit booking whose deposit has already been settled. */
async function settledDeposit(tripDays) {
  const created = await post("/api/bookings", payload({ date: tripIn(tripDays) }));
  assert.equal(created.status, 201);
  const settled = await fetch(
    `http://127.0.0.1:${mock.port}/settle?order=${created.body.code}&status=settlement`
  );
  assert.equal(settled.status, 200);
  return created.body;
}

function balanceOf(statusBody) {
  return statusBody.body.balance;
}

test("the trip date is stored, because the balance is scheduled from it", async () => {
  const created = await post("/api/bookings", payload({ date: tripIn(5) }));
  assert.equal(created.status, 201);

  const status = await get(`/api/bookings/status?code=${created.body.code}`);
  assert.equal(status.body.tripDate, tripIn(5));
  /* Nothing owed until the scheduler raises it. */
  assert.equal(status.body.balance, null);
});

test("a full-payment booking never owes a balance", async () => {
  const created = await post(
    "/api/bookings",
    payload({ paymentType: "full", expectedPayNow: 3700000, date: tripIn(5) })
  );
  assert.equal(created.status, 201);
  await fetch(`http://127.0.0.1:${mock.port}/settle?order=${created.body.code}&status=settlement`);

  const cron = await runCron();
  assert.ok(!cron.body.balances.some((row) => row.code === created.body.code && row.raised));
  assert.equal(balanceOf(await get(`/api/bookings/status?code=${created.body.code}`)), null);
});

test("a balance is not raised before the deposit is paid", async () => {
  const created = await post("/api/bookings", payload({ date: tripIn(5) }));

  const cron = await runCron();
  assert.ok(!cron.body.balances.some((row) => row.code === created.body.code && row.raised));

  const status = await get(`/api/bookings/status?code=${created.body.code}`);
  assert.equal(status.body.status, "pending");
  assert.equal(status.body.balance, null);
});

test("no balance is raised while the trip is still outside the lead window", async () => {
  const booking = await settledDeposit(90);

  const cron = await runCron();
  assert.ok(!cron.body.balances.some((row) => row.code === booking.code && row.raised));

  const status = await get(`/api/bookings/status?code=${booking.code}`);
  assert.equal(status.body.status, "paid");
  assert.equal(status.body.balance, null);
});

test("a settled deposit inside the lead window gets a payable balance", async () => {
  const booking = await settledDeposit(5);
  const owed = booking.total - booking.payNow;

  const cron = await runCron();
  const entry = cron.body.balances.find((row) => row.code === booking.code);
  assert.equal(entry.raised, true);
  assert.equal(entry.amount, owed);

  const status = await get(`/api/bookings/status?code=${booking.code}`);
  assert.equal(status.body.status, "paid", "the deposit stays paid");
  assert.equal(status.body.balance.amount, owed);
  assert.equal(status.body.balance.status, "pending");
  assert.equal(status.body.balance.type, "va");
  assert.equal(status.body.balance.bank, "bca");
  assert.match(status.body.balance.vaNumber, /^\d+$/);
});

test("the balance is chased by hand when no notification endpoint is set", async () => {
  const booking = await settledDeposit(5);
  const previous = process.env.BALANCE_NOTIFY_URL;
  delete process.env.BALANCE_NOTIFY_URL;
  try {
    const cron = await runCron();
    const entry = cron.body.balances.find((row) => row.code === booking.code);
    /* Raised, but honestly reported as not actually delivered. */
    assert.equal(entry.raised, true);
    assert.equal(entry.notified, false);
    assert.equal(entry.notice, "no_notify_url");
  } finally {
    if (previous !== undefined) process.env.BALANCE_NOTIFY_URL = previous;
  }
});

test("running the scheduler twice raises one balance, once", async () => {
  const booking = await settledDeposit(5);
  await runCron();
  const first = await get(`/api/bookings/status?code=${booking.code}`);

  const second = await runCron();
  assert.ok(!second.body.balances.some((row) => row.code === booking.code && row.raised));

  const after = await get(`/api/bookings/status?code=${booking.code}`);
  assert.equal(after.body.balance.vaNumber, first.body.balance.vaNumber);
  assert.equal(after.body.balance.amount, first.body.balance.amount);
});

test("a raise that is still in flight is not started a second time", async () => {
  const booking = await settledDeposit(5);
  await db.updateBooking(booking.code, {
    balance_status: "raising",
    balance_gateway_order_id: booking.code + "-BAL",
    balance_raised_at: new Date().toISOString()
  });

  const cron = await runCron();
  assert.ok(!cron.body.balances.some((row) => row.code === booking.code && row.raised));
});

test("a raise abandoned mid-flight is finished by a later run", async () => {
  const booking = await settledDeposit(5);

  /* A process that claimed the balance, died, and never stored the account. */
  await db.updateBooking(booking.code, {
    balance_status: "raising",
    balance_gateway_order_id: booking.code + "-BAL",
    balance_raised_at: new Date(Date.now() - 60 * 60 * 1000).toISOString()
  });

  /* A half-raise has no instructions, so it must not be shown as payable. */
  assert.equal(balanceOf(await get(`/api/bookings/status?code=${booking.code}`)), null);

  const cron = await runCron();
  const entry = cron.body.balances.find((row) => row.code === booking.code);
  assert.equal(entry.raised, true);

  const status = await get(`/api/bookings/status?code=${booking.code}`);
  assert.equal(status.body.balance.status, "pending");
  assert.match(status.body.balance.vaNumber, /^\d+$/);
});

test("settling the balance pays the balance and leaves the deposit paid", async () => {
  const booking = await settledDeposit(5);
  await runCron();

  const settled = await fetch(
    `http://127.0.0.1:${mock.port}/settle?order=${booking.code}-BAL&status=settlement`
  );
  assert.equal(settled.status, 200);

  const status = await get(`/api/bookings/status?code=${booking.code}`);
  assert.equal(status.body.status, "paid");
  assert.equal(status.body.balance.status, "paid");
});

test("a signed balance notification for the deposit amount is ignored", async () => {
  const booking = await settledDeposit(5);
  await runCron();

  const orderId = booking.code + "-BAL";
  /* The signature is genuinely ours, but it covers the deposit amount. A valid
     signature proves Midtrans sent it, not that it was for this transaction. */
  const amount = String(booking.payNow);
  const response = await fetch(appBase + "/api/webhooks/midtrans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      order_id: orderId,
      transaction_id: "wrong-amount",
      transaction_status: "settlement",
      fraud_status: "accept",
      status_code: "200",
      gross_amount: amount,
      signature_key: signatureFor(orderId, "200", amount)
    })
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).ignored, "amount_mismatch");

  const status = await get(`/api/bookings/status?code=${booking.code}`);
  assert.equal(status.body.balance.status, "pending");
});

test("a balance whose window closed without a notification reads as expired", async () => {
  const booking = await settledDeposit(5);
  await runCron();

  await db.updateBooking(booking.code, {
    balance_expires_at: new Date(Date.now() - 30 * 60 * 1000).toISOString()
  });

  const status = await get(`/api/bookings/status?code=${booking.code}`);
  assert.equal(status.body.balance.status, "expired");
  /* Expiring a balance must not touch the deposit. */
  assert.equal(status.body.status, "paid");
});

test("a balance the gateway refused is retried instead of left broken", async () => {
  const booking = await settledDeposit(5);
  const previousBase = process.env.MIDTRANS_API_BASE;
  /* Nothing listening, so the charge fails the way an outage would. */
  process.env.MIDTRANS_API_BASE = "http://127.0.0.1:1";
  try {
    const failed = await runCron();
    const entry = failed.body.balances.find((row) => row.code === booking.code);
    assert.equal(entry.raised, false);
    assert.equal(entry.reason, "gateway_error");
  } finally {
    process.env.MIDTRANS_API_BASE = previousBase;
  }

  /* The claim was handed back, so the next run can still raise it. */
  const retry = await runCron();
  const raised = retry.body.balances.find((row) => row.code === booking.code);
  assert.equal(raised.raised, true);

  const status = await get(`/api/bookings/status?code=${booking.code}`);
  assert.equal(status.body.balance.status, "pending");
});

test("dotfiles cannot be downloaded from the dev server", async () => {  const env = await fetch(appBase + "/.env");
  assert.equal(env.status, 403);
  const git = await fetch(appBase + "/.gitignore");
  assert.equal(git.status, 403);
});

test("the pricing file the server reads is the one the browser reads", async () => {
  const response = await fetch(appBase + "/assets/data/pricing.json");
  assert.equal(response.status, 200);
  const served = await response.json();
  assert.equal(served.depositShare, 0.3);
  assert.equal(served.packages.length, 6);
});
