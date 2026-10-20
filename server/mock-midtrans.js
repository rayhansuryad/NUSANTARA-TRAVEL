import { createHash } from "node:crypto";
import { createServer } from "node:http";

/*
 * A stand-in for api.sandbox.midtrans.com so the whole flow can be exercised
 * without a Midtrans account. It signs notifications exactly as Midtrans does,
 * which means the real signature verification runs against it unchanged.
 *
 * Never used in production: MIDTRANS_API_BASE is only set by server/dev.js.
 */
export function startMockGateway({ port, appBase, serverKey, bank = "bca" }) {
  const transactions = new Map();
  const notifications = [];
  /* The QR image URL has to carry the real port, which is unknown until the
     server is listening when port is 0. */
  let boundPort = port;

  function signatureFor(orderId, statusCode, grossAmount) {
    return createHash("sha512")
      .update(orderId + statusCode + grossAmount + serverKey)
      .digest("hex");
  }

  function notificationBody(record) {
    return JSON.stringify({
      order_id: record.order_id,
      transaction_id: record.transaction_id,
      transaction_status: record.transaction_status,
      fraud_status: record.fraud_status,
      status_code: record.status_code,
      gross_amount: record.gross_amount,
      payment_type: record.payment_type,
      signature_key: signatureFor(record.order_id, record.status_code, record.gross_amount)
    });
  }

  async function deliver(record) {
    const response = await fetch(appBase + "/api/webhooks/midtrans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: notificationBody(record)
    });
    const text = await response.text();
    notifications.push({ order: record.order_id, status: record.transaction_status, http: response.status, text });
    return { http: response.status, body: text };
  }

  function json(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  }

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const route = url.pathname;

    /* --- control surface, not part of the Midtrans API --- */

    if (route === "/settle") {
      const order = url.searchParams.get("order") || "";
      const record = transactions.get(order);
      if (!record) return json(res, 404, { error: "unknown_order", order });

      record.transaction_status = url.searchParams.get("status") || "settlement";
      if (record.transaction_status === "capture") record.fraud_status = "accept";
      record.status_code = "200";

      const times = Math.max(1, Number(url.searchParams.get("times")) || 1);
      const results = [];
      for (let i = 0; i < times; i += 1) results.push(await deliver(record));

      return json(res, 200, { order, status: record.transaction_status, times, results, notifications });
    }

    if (route === "/mock-qr.svg") {
      const order = url.searchParams.get("order") || "NT-DEMO";
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 24 24" shape-rendering="crispEdges"><rect width="24" height="24" fill="#ffffff"/><g fill="#14263f">${Array.from({ length: 140 }, (_, i) => {
        const x = (i * 7) % 22;
        const y = Math.floor((i * 13) % 22);
        return `<rect x="${x}" y="${y}" width="1" height="1"/>`;
      }).join("")}</g><text x="12" y="23" font-size="1.4" text-anchor="middle" fill="#5f7085">mock ${order}</text></svg>`;
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
      return res.end(svg);
    }

    /* --- the two Midtrans endpoints the application actually calls --- */

    if (route === "/v2/charge" && req.method === "POST") {
      let parsed;
      try {
        parsed = JSON.parse((await readBody(req)) || "{}");
      } catch {
        return json(res, 400, { status_code: "400", status_message: "Malformed JSON" });
      }

      const orderId = parsed.transaction_details && parsed.transaction_details.order_id;
      const amount = Number(parsed.transaction_details && parsed.transaction_details.gross_amount);

      if (!orderId || !Number.isFinite(amount)) {
        return json(res, 400, { status_code: "400", status_message: "Missing transaction_details" });
      }

      const record = {
        order_id: orderId,
        gross_amount: amount.toFixed(2),
        payment_type: parsed.payment_type,
        transaction_status: "pending",
        fraud_status: "",
        status_code: "201",
        transaction_id: "mock-" + Math.random().toString(16).slice(2, 12),
        expiry_time: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        va_number: String(8808000000000000 + Math.floor(Math.random() * 899999999)),
        bank
      };
      transactions.set(orderId, record);

      if (parsed.payment_type === "qris") {
        return json(res, 200, {
          status_code: "201",
          status_message: "QRIS transaction is created",
          transaction_id: record.transaction_id,
          order_id: orderId,
          gross_amount: record.gross_amount,
          payment_type: "qris",
          transaction_status: "pending",
          fraud_status: "",
          expiry_time: record.expiry_time,
          actions: [
            {
              name: "generate-qr-code",
              method: "GET",
              url: `http://127.0.0.1:${boundPort}/mock-qr.svg?order=${encodeURIComponent(orderId)}`
            }
          ]
        });
      }

      /* Permata answers with one top-level field rather than a va_numbers list,
         exactly as the real API does, so that branch is genuinely exercised. */
      if (bank === "permata") {
        return json(res, 200, {
          status_code: "201",
          status_message: "VA transaction is created",
          transaction_id: record.transaction_id,
          order_id: orderId,
          gross_amount: record.gross_amount,
          payment_type: "bank_transfer",
          transaction_status: "pending",
          fraud_status: "",
          expiry_time: record.expiry_time,
          permata_va_number: record.va_number
        });
      }

      return json(res, 200, {
        status_code: "201",
        status_message: "VA transaction is created",
        transaction_id: record.transaction_id,
        order_id: orderId,
        gross_amount: record.gross_amount,
        payment_type: "bank_transfer",
        transaction_status: "pending",
        fraud_status: "",
        expiry_time: record.expiry_time,
        va_numbers: [{ bank, va_number: record.va_number }]
      });
    }

    const statusMatch = route.match(/^\/v2\/([^/]+)\/status$/);
    if (statusMatch && req.method === "GET") {
      const orderId = decodeURIComponent(statusMatch[1]);
      const record = transactions.get(orderId);
      if (!record) {
        return json(res, 404, { status_code: "404", status_message: "Transaction not found" });
      }
      return json(res, 200, {
        status_code: record.status_code,
        transaction_id: record.transaction_id,
        order_id: record.order_id,
        transaction_status: record.transaction_status,
        fraud_status: record.fraud_status,
        gross_amount: record.gross_amount,
        payment_type: record.payment_type
      });
    }

    return json(res, 404, { status_code: "404", status_message: "Unknown mock route" });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      boundPort = server.address().port;
      resolve({
        port: boundPort,
        close: () => new Promise((done) => server.close(done)),
        notifications,
        transactions
      });
    });
  });
}
