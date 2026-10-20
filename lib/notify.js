/*
 * The customer has to be told a balance is payable, and there is no email
 * provider baked into this project, so rather than invent credentials the
 * message is handed to whatever endpoint you point BALANCE_NOTIFY_URL at. That
 * suits Resend, Zapier, Make, or a route of your own.
 *
 * With no URL set, the message is logged in full. A balance that was raised but
 * never announced is the one failure nobody notices until the customer arrives,
 * so the run is never silent about it.
 */
export async function notifyBalanceRaised(row) {
  const payload = {
    type: "balance_due",
    code: row.code,
    name: row.name,
    email: row.email,
    phone: row.phone,
    amount: row.balance_amount,
    currency: "IDR",
    tripDate: row.trip_date,
    method: row.method,
    bank: row.balance_bank,
    vaNumber: row.balance_va_number,
    qrUrl: row.balance_qr_url,
    expiresAt: row.balance_expires_at,
    statusUrl: balanceStatusHint(row.code)
  };

  const url = process.env.BALANCE_NOTIFY_URL;
  if (!url) {
    console.log("[balance] no BALANCE_NOTIFY_URL set, send this by hand:", JSON.stringify(payload));
    return { ok: true, delivered: false, reason: "no_notify_url" };
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      return { ok: false, delivered: false, reason: "http_" + response.status };
    }
    return { ok: true, delivered: true };
  } catch (error) {
    /* A failed notification must not undo the balance that was already raised. */
    return { ok: false, delivered: false, reason: String((error && error.message) || error) };
  }
}

function balanceStatusHint(code) {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) return "";
  return base.replace(/\/+$/, "") + "/api/bookings/status?code=" + encodeURIComponent(code);
}
