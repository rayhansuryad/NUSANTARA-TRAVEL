import path from "node:path";
import { createApp, listen, root } from "./app.js";
import { startMockGateway } from "./mock-midtrans.js";

/* Load .env before anything reads process.env. */
try {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(path.join(root, ".env"));
  }
} catch {
  /* No .env yet. The defaults below are enough to run offline. */
}

const port = Number(process.env.PORT) || 8787;
const mockPort = port + 1;

/* Dev defaults. A local mock accepts any key, so this one is not a secret and
   is never valid against real Midtrans. */
process.env.MIDTRANS_ENV = process.env.MIDTRANS_ENV || "sandbox";
process.env.MIDTRANS_SERVER_KEY = process.env.MIDTRANS_SERVER_KEY || "SB-Mid-server-LOCAL_MOCK_ONLY";
process.env.MIDTRANS_BANK = process.env.MIDTRANS_BANK || "bca";
process.env.MIDTRANS_EXPIRY_HOURS = process.env.MIDTRANS_EXPIRY_HOURS || "24";
process.env.BALANCE_LEAD_DAYS = process.env.BALANCE_LEAD_DAYS || "14";
process.env.CRON_SECRET = process.env.CRON_SECRET || "dev-cron-secret";
process.env.SQLITE_PATH = process.env.SQLITE_PATH || path.join(root, ".data", "bookings.db");
process.env.MIDTRANS_API_BASE = process.env.MIDTRANS_API_BASE || `http://127.0.0.1:${mockPort}`;

await listen(createApp(), port);
await startMockGateway({
  port: mockPort,
  appBase: `http://127.0.0.1:${port}`,
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  bank: process.env.MIDTRANS_BANK
});

console.log("Nusantara Travel dev server");
console.log(`  page          http://127.0.0.1:${port}/index.html`);
console.log(`  api           http://127.0.0.1:${port}/api/bookings`);
console.log(`  database      ${process.env.DATABASE_URL ? "postgres" : process.env.SQLITE_PATH}`);
console.log(`  mock gateway  http://127.0.0.1:${mockPort}`);
console.log("");
console.log("  Settle a booking without paying:");
console.log(`    http://127.0.0.1:${mockPort}/settle?order=<CODE>&status=settlement`);
console.log("  Other useful statuses: capture, expire, deny, cancel, refund");
console.log(`  Reconcile cron: http://127.0.0.1:${port}/api/cron/reconcile`);
console.log(`    header  x-cron-secret: ${process.env.CRON_SECRET}`);
console.log(`  Balance for a deposit booking is raised when the trip is within`);
console.log(`    ${process.env.BALANCE_LEAD_DAYS} days. Settle that one with the same route,`);
console.log(`    using <CODE>-BAL as the order.`);
console.log("");
console.log("  REMINDER  index.html needs CONFIG.apiBase set to \"\" to use this API.");
