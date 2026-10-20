import { createBooking } from "../../lib/booking.js";
import {
  clientIp,
  corsHeaders,
  handlePreflight,
  methodNotAllowed,
  rateLimit,
  readJson,
  sendJson
} from "../../lib/http.js";
import { assertConfiguration } from "../../lib/midtrans.js";

/* Read per request so a deployment can raise or lower it without a code
   change, and so tests are not throttled by their own fixtures. */
function bookingLimit() {
  const value = Number(process.env.BOOKING_RATE_LIMIT);
  return Number.isFinite(value) && value > 0 ? value : 10;
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (req.method !== "POST") return methodNotAllowed(res, ["POST", "OPTIONS"]);

  /* Every accepted request can create a billable virtual account, so this is
     the endpoint that most needs a ceiling. */
  const limit = rateLimit("bookings:" + clientIp(req), bookingLimit(), 60_000);
  if (!limit.allowed) {
    return sendJson(
      res,
      429,
      { error: "rate_limited", message: "Too many booking attempts. Try again shortly." },
      { ...corsHeaders(), "Retry-After": String(limit.retryAfter) }
    );
  }

  try {
    assertConfiguration();
  } catch (error) {
    /* Our misconfiguration, so log the detail and tell the customer nothing. */
    console.error("Payment configuration is invalid:", error.message);
    return sendJson(
      res,
      500,
      { error: "server", message: "Payment is not configured on this server" },
      corsHeaders()
    );
  }

  let payload;
  try {
    payload = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, { error: "invalid", message: error.message }, corsHeaders());
  }

  try {
    const result = await createBooking(payload);

    if (result.ok) {
      return sendJson(res, result.status, result.body, corsHeaders());
    }

    return sendJson(
      res,
      result.status,
      { error: result.error, message: result.message, errors: result.errors, code: result.code },
      corsHeaders()
    );
  } catch (error) {
    console.error("Booking creation failed:", error);
    return sendJson(
      res,
      500,
      { error: "server", message: "Could not create the booking" },
      corsHeaders()
    );
  }
}
