import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SQLITE_PATH = path.join(here, "..", ".data", "bookings.db");

/* Same DDL for both engines: TEXT, INTEGER, NOT NULL, DEFAULT and
   CREATE INDEX IF NOT EXISTS all behave identically. */
const DDL = `
CREATE TABLE IF NOT EXISTS bookings (
  code TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  package_id TEXT NOT NULL,
  participants INTEGER NOT NULL,
  accommodation_id TEXT NOT NULL,
  addon_ids TEXT NOT NULL DEFAULT '',
  payment_type TEXT NOT NULL,
  method TEXT NOT NULL,
  trip_date TEXT NOT NULL DEFAULT '',
  total INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  gateway TEXT NOT NULL DEFAULT 'midtrans',
  gateway_order_id TEXT,
  gateway_transaction_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  va_number TEXT NOT NULL DEFAULT '',
  bank TEXT NOT NULL DEFAULT '',
  qr_url TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  paid_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  balance_amount INTEGER NOT NULL DEFAULT 0,
  balance_status TEXT NOT NULL DEFAULT '',
  balance_gateway_order_id TEXT,
  balance_va_number TEXT NOT NULL DEFAULT '',
  balance_bank TEXT NOT NULL DEFAULT '',
  balance_qr_url TEXT NOT NULL DEFAULT '',
  balance_expires_at TEXT NOT NULL DEFAULT '',
  balance_raised_at TEXT NOT NULL DEFAULT '',
  balance_paid_at TEXT NOT NULL DEFAULT '',
  balance_attempts INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS bookings_gateway_order
  ON bookings (gateway_order_id);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL DEFAULT '',
  transaction_status TEXT NOT NULL DEFAULT '',
  signature_ok INTEGER NOT NULL DEFAULT 0,
  raw TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS bookings_status_idx ON bookings (status);
`;

/*
 * CREATE TABLE IF NOT EXISTS leaves an existing table exactly as it found it,
 * so a column added later has to be declared twice: once above for new
 * databases, once here for databases that already exist. Every run after the
 * first is expected to fail on "duplicate column", so that error is swallowed.
 */
const COLUMN_ADDITIONS = [
  "trip_date TEXT NOT NULL DEFAULT ''",
  "balance_amount INTEGER NOT NULL DEFAULT 0",
  "balance_status TEXT NOT NULL DEFAULT ''",
  "balance_gateway_order_id TEXT",
  "balance_va_number TEXT NOT NULL DEFAULT ''",
  "balance_bank TEXT NOT NULL DEFAULT ''",
  "balance_qr_url TEXT NOT NULL DEFAULT ''",
  "balance_expires_at TEXT NOT NULL DEFAULT ''",
  "balance_raised_at TEXT NOT NULL DEFAULT ''",
  "balance_paid_at TEXT NOT NULL DEFAULT ''",
  "balance_attempts INTEGER NOT NULL DEFAULT 0"
];

const BALANCE_INDEXES = [
  "CREATE UNIQUE INDEX IF NOT EXISTS bookings_balance_order ON bookings (balance_gateway_order_id)",
  "CREATE INDEX IF NOT EXISTS bookings_balance_status_idx ON bookings (balance_status)"
];

function isDuplicateColumn(error) {
  if (!error) return false;
  if (error.code === "42701") return true;
  return /duplicate column name|already exists/i.test(String(error.message || ""));
}

const UPDATABLE = [
  "status",
  "gateway_transaction_id",
  "va_number",
  "bank",
  "qr_url",
  "expires_at",
  "created_at",
  "paid_at",
  "updated_at",
  "balance_amount",
  "balance_status",
  "balance_gateway_order_id",
  "balance_va_number",
  "balance_bank",
  "balance_qr_url",
  "balance_expires_at",
  "balance_raised_at",
  "balance_paid_at",
  "balance_attempts"
];

let driverPromise = null;

/* Postgres positional parameters are $1, $2; ours are written ? for both. */
function toPostgresPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => "$" + (index += 1));
}

async function createDriver() {
  const url = process.env.DATABASE_URL;

  if (url) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({
      connectionString: url,
      max: 3,
      ssl: process.env.DATABASE_SSL === "off" ? false : { rejectUnauthorized: false }
    });
    return {
      name: "postgres",
      async exec(sql) {
        await pool.query(sql);
      },
      async run(sql, params = []) {
        const result = await pool.query(toPostgresPlaceholders(sql), params);
        return { rows: result.rows, rowCount: result.rowCount };
      },
      async close() {
        await pool.end();
      }
    };
  }

  /* Local development and tests. node:sqlite ships with Node, so there is
     nothing to install to run the whole flow offline. */
  const { DatabaseSync } = await import("node:sqlite");
  const file = process.env.SQLITE_PATH || DEFAULT_SQLITE_PATH;
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");

  return {
    name: "sqlite",
    /* exec() for DDL: prepare() compiles only the first statement in a
       multi-statement string, which silently skips the later tables. */
    async exec(sql) {
      db.exec(sql);
    },
    async run(sql, params = []) {
      const statement = db.prepare(sql);
      /* node:sqlite exposes rows only through all()/get(), so SELECT and
         anything else are routed differently. */
      if (/^\s*select/i.test(sql)) {
        return { rows: statement.all(...params), rowCount: 0 };
      }
      const info = statement.run(...params);
      return { rows: [], rowCount: Number(info.changes) };
    },
    async close() {
      db.close();
    }
  };
}

/* Existing databases need the new columns and indexes before anything reads
   them. A fresh database already has them and every ALTER is a no-op. */
async function migrate(driver) {
  for (const definition of COLUMN_ADDITIONS) {
    try {
      await driver.run(`ALTER TABLE bookings ADD COLUMN ${definition}`);
    } catch (error) {
      if (!isDuplicateColumn(error)) throw error;
    }
  }
  for (const statement of BALANCE_INDEXES) {
    await driver.run(statement);
  }
}

async function getDriver() {
  if (!driverPromise) {
    driverPromise = (async () => {
      const driver = await createDriver();
      await driver.exec(DDL);
      await migrate(driver);
      return driver;
    })();
  }
  return driverPromise;
}

export async function init() {
  await getDriver();
}

export function driverName() {
  return process.env.DATABASE_URL ? "postgres" : "sqlite";
}

export async function close() {
  if (!driverPromise) return;
  const driver = await driverPromise;
  driverPromise = null;
  await driver.close();
}

/* --- bookings --- */

export async function insertBooking(row) {
  const driver = await getDriver();
  const columns = [
    "code", "idempotency_key", "package_id", "participants", "accommodation_id",
    "addon_ids", "payment_type", "method", "trip_date", "total", "amount", "name",
    "email", "phone", "notes", "gateway", "gateway_order_id",
    "gateway_transaction_id", "status", "va_number", "bank", "qr_url",
    "expires_at", "created_at", "paid_at", "updated_at",
    "balance_amount", "balance_status", "balance_gateway_order_id",
    "balance_va_number", "balance_bank", "balance_qr_url", "balance_expires_at",
    "balance_raised_at", "balance_paid_at", "balance_attempts"
  ];
  const placeholders = columns.map(() => "?").join(", ");
  await driver.run(
    `INSERT INTO bookings (${columns.join(", ")}) VALUES (${placeholders})`,
    columns.map((column) => row[column])
  );
  return getBooking(row.code);
}

export async function getBooking(code) {
  const driver = await getDriver();
  const { rows } = await driver.run("SELECT * FROM bookings WHERE code = ?", [code]);
  return rows[0] || null;
}

export async function getBookingByIdempotencyKey(key) {
  const driver = await getDriver();
  const { rows } = await driver.run(
    "SELECT * FROM bookings WHERE idempotency_key = ?",
    [key]
  );
  return rows[0] || null;
}

/*
 * A booking owns two order ids once a balance has been raised: the deposit's
 * and the balance's. A notification carries one of them with no hint which, so
 * look up both columns. balance_gateway_order_id is NULL for most rows, and a
 * NULL never equals a string, so this stays a single indexed lookup.
 */
export async function getBookingByAnyOrderId(orderId) {
  const driver = await getDriver();
  const { rows } = await driver.run(
    "SELECT * FROM bookings WHERE gateway_order_id = ? OR balance_gateway_order_id = ?",
    [orderId, orderId]
  );
  return rows[0] || null;
}

export async function updateBooking(code, fields) {
  const entries = Object.entries(fields).filter(([column]) => UPDATABLE.includes(column));
  if (!entries.length) return getBooking(code);

  const driver = await getDriver();
  const assignments = entries.map(([column]) => `${column} = ?`).join(", ");
  const params = entries.map(([, value]) => value);
  await driver.run(
    `UPDATE bookings SET ${assignments} WHERE code = ?`,
    [...params, code]
  );
  return getBooking(code);
}

/* Used to release a reservation that never produced payment instructions, so
   the same idempotency key can be reused. Nothing was ever charged for it. */
export async function deleteBooking(code) {
  const driver = await getDriver();
  await driver.run("DELETE FROM bookings WHERE code = ?", [code]);
}

/* Used by the reconcile cron: bookings that never reached a terminal state. */
export async function listUnsettledBefore(iso, limit = 25) {
  const driver = await getDriver();
  const { rows } = await driver.run(
    "SELECT code, gateway_order_id, updated_at FROM bookings " +
      "WHERE status = 'pending' AND updated_at < ? ORDER BY updated_at ASC LIMIT ?",
    [iso, limit]
  );
  return rows;
}

/*
 * Deposit paid, balance not raised yet, and the trip is inside the lead window.
 * A booking with no trip_date is skipped rather than guessed at, since there is
 * no honest way to decide when its balance is due.
 *
 * A stale "raising" row is included so the same run can finish a raise that a
 * dead process abandoned.
 */
export async function listBalancesDue(cutoffDate, staleBefore, limit = 25) {
  const driver = await getDriver();
  const { rows } = await driver.run(
    "SELECT * FROM bookings " +
      "WHERE payment_type = 'dp' AND status = 'paid' " +
      "AND (balance_status = '' " +
      "  OR (balance_status = 'raising' AND balance_raised_at <> '' AND balance_raised_at < ?)) " +
      "AND trip_date <> '' AND trip_date <= ? ORDER BY trip_date ASC LIMIT ?",
    [staleBefore, cutoffDate, limit]
  );
  return rows;
}

/* --- webhook audit trail --- */

export async function insertWebhookEvent(event) {
  const driver = await getDriver();
  await driver.run(
    "INSERT INTO webhook_events (id, order_id, transaction_id, transaction_status, " +
      "signature_ok, raw, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      event.id,
      event.orderId,
      event.transactionId || "",
      event.transactionStatus || "",
      event.signatureOk ? 1 : 0,
      event.raw,
      event.receivedAt
    ]
  );
}

/*
 * Claims the right to raise a booking's balance, so two cron instances running
 * at once cannot both charge one. The WHERE clause is the whole point: the
 * update only lands while the balance is unclaimed, or while a previous claim
 * has gone stale, and while there are attempts left. rowCount of 1 means this
 * caller won.
 *
 * The stale window exists because "raising" is written before the gateway call
 * and replaced after it. A process that dies in between would otherwise leave a
 * balance that is neither payable nor retried.
 */
export async function claimBalance(code, orderId, timestamp, maxAttempts = 5, staleBefore = "") {
  const driver = await getDriver();
  const { rowCount } = await driver.run(
    "UPDATE bookings SET balance_status = 'raising', balance_gateway_order_id = ?, " +
      "balance_raised_at = ?, balance_attempts = balance_attempts + 1, updated_at = ? " +
      "WHERE code = ? AND balance_attempts < ? " +
      "AND (balance_status = '' OR (balance_status = 'raising' AND balance_raised_at < ?))",
    [orderId, timestamp, timestamp, code, maxAttempts, staleBefore]
  );
  return rowCount === 1;
}

/* Give the claim back after a charge that never produced payment instructions,
   so the next scheduled run can try again. */
export async function releaseBalance(code, timestamp) {
  const driver = await getDriver();
  await driver.run(
    "UPDATE bookings SET balance_status = '', balance_gateway_order_id = NULL, updated_at = ? " +
      "WHERE code = ? AND balance_status = 'raising'",
    [timestamp, code]
  );
}

export function isUniqueViolation(error) {
  if (!error) return false;
  if (error.code === "23505") return true;
  return /UNIQUE constraint failed/i.test(String(error.message || ""));
}
