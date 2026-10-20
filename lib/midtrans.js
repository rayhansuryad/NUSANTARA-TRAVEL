import { createHash, timingSafeEqual } from "node:crypto";

/* Midtrans Core API gives back the raw virtual account number and the QR image,
   which is what the inline checkout on the page needs. */
const SANDBOX_BASE = "https://api.sandbox.midtrans.com";
const PRODUCTION_BASE = "https://api.midtrans.com";

export const supportedBanks = ["bca", "bni", "bri", "permata"];

function env() {
  return (process.env.MIDTRANS_ENV || "sandbox").toLowerCase() === "production"
    ? "production"
    : "sandbox";
}

function serverKey() {
  return process.env.MIDTRANS_SERVER_KEY || "";
}

function apiBase() {
  if (process.env.MIDTRANS_API_BASE) return process.env.MIDTRANS_API_BASE.replace(/\/+$/, "");
  return env() === "production" ? PRODUCTION_BASE : SANDBOX_BASE;
}

export function configuredBank() {
  return (process.env.MIDTRANS_BANK || "bca").toLowerCase();
}

/*
 * Called once at startup. A sandbox key against the production URL fails in a
 * confusing way much later, so refuse to run at all.
 */
export function assertConfiguration() {
  const key = serverKey();
  if (!key) throw new Error("MIDTRANS_SERVER_KEY is not set");

  const looksSandbox = key.startsWith("SB-Mid-server-");
  const looksProduction = key.startsWith("Mid-server-");

  /* A local mock accepts anything, so only apply the pairing rule to the real
     Midtrans hosts. */
  if (!process.env.MIDTRANS_API_BASE) {
    if (env() === "production" && looksSandbox) {
      throw new Error(
        "MIDTRANS_ENV=production but MIDTRANS_SERVER_KEY is a sandbox key (SB-Mid-server-...)"
      );
    }
    if (env() === "sandbox" && looksProduction) {
      throw new Error(
        "MIDTRANS_ENV=sandbox but MIDTRANS_SERVER_KEY is a production key (Mid-server-...)"
      );
    }
    if (!looksSandbox && !looksProduction) {
      throw new Error("MIDTRANS_SERVER_KEY does not look like a Midtrans server key");
    }
  }

  const bank = configuredBank();
  if (!supportedBanks.includes(bank)) {
    throw new Error(
      `MIDTRANS_BANK="${bank}" is not supported yet. Supported: ${supportedBanks.join(", ")}. ` +
        "Mandiri uses the separate echannel request shape and is not wired up."
    );
  }
}

async function call(pathname, { method = "POST", body } = {}) {
  const response = await fetch(apiBase() + pathname, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from(serverKey() + ":").toString("base64")
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* Leave parsed null and fall back to the raw text below. */
  }

  /* Midtrans reports some failures as HTTP 200 with a non-2xx status_code. */
  const gatewayCode = parsed && parsed.status_code ? String(parsed.status_code) : "";
  const failed = !response.ok || (gatewayCode && gatewayCode[0] !== "2");

  if (failed) {
    const detail =
      (parsed && (parsed.status_message || (parsed.error_messages || []).join("; "))) ||
      text.slice(0, 300) ||
      "no response body";
    const error = new Error(`Midtrans ${pathname} failed: ${detail}`);
    error.gateway = true;
    error.statusCode = response.status;
    throw error;
  }

  return parsed || {};
}

function customerDetails(customer) {
  const parts = String(customer.name || "").split(" ");
  return {
    first_name: parts[0] || "Guest",
    last_name: parts.slice(1).join(" ") || undefined,
    email: customer.email,
    phone: customer.phone
  };
}

/*
 * Creates the transaction and normalises the response into the small shape the
 * page needs, so the browser never has to understand Midtrans payloads.
 */
export async function charge({ orderId, amount, method, customer, expiryHours }) {
  const expiry = {
    custom_expiry: { expiry_duration: expiryHours, unit: "hour" }
  };

  if (method === "qris") {
    const result = await call("/v2/charge", {
      body: {
        payment_type: "qris",
        transaction_details: { order_id: orderId, gross_amount: amount },
        qris: { acquirer: "gopay" },
        customer_details: customerDetails(customer),
        ...expiry
      }
    });
    const action = (result.actions || []).find((entry) => entry.name === "generate-qr-code");
    if (!action || !action.url) {
      throw new Error("Midtrans returned no QR image for this transaction");
    }
    return {
      transactionId: result.transaction_id || "",
      transactionStatus: result.transaction_status || "pending",
      expiresAt: result.expiry_time || "",
      payment: { type: "qris", qrUrl: action.url }
    };
  }

  const bank = configuredBank();
  const result = await call("/v2/charge", {
    body: {
      payment_type: "bank_transfer",
      transaction_details: { order_id: orderId, gross_amount: amount },
      bank_transfer: { bank },
      customer_details: customerDetails(customer),
      ...expiry
    }
  });

  const entry = (result.va_numbers || []).find((item) => item.va_number);
  /* Permata answers with one top-level field instead of the va_numbers list. */
  const vaNumber = entry ? entry.va_number : result.permata_va_number;
  if (!vaNumber) {
    throw new Error("Midtrans returned no virtual account number for this transaction");
  }

  return {
    transactionId: result.transaction_id || "",
    transactionStatus: result.transaction_status || "pending",
    expiresAt: result.expiry_time || "",
    payment: { type: "va", bank: (entry && entry.bank) || bank, vaNumber }
  };
}

/* Server-to-server status lookup. The webhook is the primary source of truth,
   this is the safety net for a notification that never arrived. */
export async function fetchStatus(orderId) {
  const result = await call("/v2/" + encodeURIComponent(orderId) + "/status", { method: "GET" });
  return {
    orderId: result.order_id,
    transactionId: result.transaction_id || "",
    transactionStatus: result.transaction_status || "",
    fraudStatus: result.fraud_status || "",
    statusCode: result.status_code || "",
    grossAmount: result.gross_amount || ""
  };
}

/*
 * signature_key is SHA-512 of order_id + status_code + gross_amount + server key.
 * Comparing with timingSafeEqual keeps the check from leaking through timing.
 */
export function verifySignature({ orderId, statusCode, grossAmount, signatureKey }) {
  if (!signatureKey || !serverKey()) return false;
  const expected = createHash("sha512")
    .update(String(orderId) + String(statusCode) + String(grossAmount) + serverKey())
    .digest("hex");
  return safeEqualHex(expected, String(signatureKey));
}

function safeEqualHex(a, b) {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/* An unrecognised status maps to null so a booking is never moved by a value
   we do not understand. */
export function mapStatus(transactionStatus, fraudStatus) {
  switch (transactionStatus) {
    case "capture":
      return fraudStatus === "accept" ? "paid" : "pending";
    case "settlement":
      return "paid";
    case "pending":
      return "pending";
    case "deny":
    case "cancel":
      return "failed";
    case "expire":
      return "expired";
    case "refund":
    case "partial_refund":
      return "refunded";
    default:
      return null;
  }
}

export function isTerminal(status) {
  return status === "paid" || status === "expired" || status === "failed" || status === "refunded";
}
