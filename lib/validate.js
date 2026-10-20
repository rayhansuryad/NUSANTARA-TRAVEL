import {
  accommodationIds,
  maxParticipants,
  normaliseAddons,
  packageIds,
  supportedMethods,
  supportedPaymentTypes
} from "./pricing.js";

const MAX_TEXT = { name: 120, email: 200, phone: 32, notes: 1000 };

/* Deliberately loose. The point is to reject junk and bound the length, not to
   decide whether an address truly exists. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function clean(value, limit) {
  if (typeof value !== "string") return "";
  /* Strip control characters: these strings end up in emails and in the
     payment description. */
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function localToday() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

/*
 * Returns { ok: true, value } or { ok: false, errors: {field: reason} }.
 * Everything the database or the gateway will see comes out of here, so the
 * handlers never touch raw request data.
 */
export function validateBookingPayload(input) {
  const errors = {};
  const raw = input && typeof input === "object" ? input : {};

  const value = {
    packageId: typeof raw.packageId === "string" ? raw.packageId : "",
    accommodationId: typeof raw.accommodationId === "string" ? raw.accommodationId : "",
    paymentType: typeof raw.paymentType === "string" ? raw.paymentType : "",
    method: typeof raw.method === "string" ? raw.method : "",
    date: typeof raw.date === "string" ? raw.date : "",
    participants: Number(raw.participants),
    name: clean(raw.name, MAX_TEXT.name),
    email: clean(raw.email, MAX_TEXT.email).toLowerCase(),
    phone: clean(raw.phone, MAX_TEXT.phone),
    notes: clean(raw.notes, MAX_TEXT.notes),
    idempotencyKey: typeof raw.idempotencyKey === "string" ? raw.idempotencyKey.trim() : "",
    expectedTotal: Number(raw.expectedTotal),
    expectedPayNow: Number(raw.expectedPayNow)
  };

  const addons = normaliseAddons(raw.addonIds);
  if (addons === null) {
    errors.addonIds = "unknown addon";
  } else {
    value.addons = addons;
  }

  if (!packageIds.includes(value.packageId)) errors.packageId = "unknown package";
  if (!accommodationIds.includes(value.accommodationId)) {
    errors.accommodationId = "unknown accommodation";
  }
  if (!supportedPaymentTypes.includes(value.paymentType)) {
    errors.paymentType = "unknown payment type";
  }
  if (!supportedMethods.includes(value.method)) errors.method = "unsupported method";

  if (!Number.isInteger(value.participants) || value.participants < 1 || value.participants > maxParticipants) {
    errors.participants = "participants out of range";
  }

  if (!DATE.test(value.date) || Number.isNaN(Date.parse(value.date + "T00:00:00Z"))) {
    errors.date = "invalid date";
  } else if (value.date < localToday()) {
    errors.date = "date in the past";
  }

  if (value.name.length < 2) errors.name = "name too short";
  if (!EMAIL.test(value.email)) errors.email = "invalid email";

  const digits = value.phone.replace(/\D/g, "");
  if (digits.length < 9 || digits.length > 15) errors.phone = "invalid phone";

  if (!/^[A-Za-z0-9-]{8,64}$/.test(value.idempotencyKey)) {
    errors.idempotencyKey = "missing or malformed idempotency key";
  }

  const keys = Object.keys(errors);
  if (keys.length) return { ok: false, errors };

  /* Drop the raw addonIds field so callers cannot accidentally read it. */
  delete value.addonIds;
  return { ok: true, value };
}
