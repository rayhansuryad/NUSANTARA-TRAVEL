import { getPublicBooking } from "../../lib/booking.js";
import {
  clientIp,
  corsHeaders,
  handlePreflight,
  methodNotAllowed,
  rateLimit,
  sendJson
} from "../../lib/http.js";

/* A path segment rather than /api/bookings/:code, because the bracket-file
   dynamic route form is a Next.js feature and this project is plain Vercel
   Functions. A query parameter works identically on every host. */
export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (req.method !== "GET") return methodNotAllowed(res, ["GET", "OPTIONS"]);

  const limit = rateLimit("status:" + clientIp(req), 120, 60_000);
  if (!limit.allowed) {
    return sendJson(
      res,
      429,
      { error: "rate_limited" },
      { ...corsHeaders(), "Retry-After": String(limit.retryAfter) }
    );
  }

  const url = new URL(req.url, "http://localhost");
  const code = (url.searchParams.get("code") || "").trim().toUpperCase();

  if (!/^NT-[A-Z0-9]{6,12}$/.test(code)) {
    return sendJson(res, 400, { error: "invalid", message: "Missing or malformed code" }, corsHeaders());
  }

  const booking = await getPublicBooking(code);
  if (!booking) return sendJson(res, 404, { error: "not_found" }, corsHeaders());

  /* The code is the only credential here, so return the payment state and
     nothing else. No name, no email, no notes. */
  return sendJson(
    res,
    200,
    {
      code: booking.code,
      status: booking.status,
      total: booking.total,
      payNow: booking.payNow,
      expiresAt: booking.expiresAt,
      balance: booking.balance,
      tripDate: booking.tripDate
    },
    corsHeaders()
  );
}
