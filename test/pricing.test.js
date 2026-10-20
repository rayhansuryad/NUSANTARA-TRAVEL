import assert from "node:assert/strict";
import { test } from "node:test";
import { computeTotal, depositShare, normaliseAddons, payNowFor } from "../lib/pricing.js";
import { validateBookingPayload } from "../lib/validate.js";

const base = {
  packageId: "borobudur",
  accommodationId: "star3",
  paymentType: "full",
  method: "va",
  date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
  participants: 2,
  name: "Budi Santoso",
  email: "budi@example.com",
  phone: "081234567890",
  notes: "",
  idempotencyKey: "11111111-2222-3333-4444-555555555555"
};

test("computeTotal matches the published calculator example", () => {
  /* 1,850,000 base x 2 travelers, 3-star multiplier of 1. */
  const quote = computeTotal({
    packageId: "borobudur",
    participants: 2,
    accommodationId: "star3",
    addons: []
  });
  assert.equal(quote.total, 3700000);
});

test("computeTotal applies the 4-star multiplier", () => {
  const quote = computeTotal({
    packageId: "borobudur",
    participants: 3,
    accommodationId: "star4",
    addons: []
  });
  /* 1,850,000 x 1.25 x 3 */
  assert.equal(quote.total, 6937500);
});

test("computeTotal charges per-trip add-ons once and per-person add-ons per head", () => {
  const quote = computeTotal({
    packageId: "borobudur",
    participants: 3,
    accommodationId: "star4",
    addons: ["drone"]
  });
  /* 6,937,500 + 750,000 once */
  assert.equal(quote.total, 7687500);
});

test("computeTotal returns null for unknown selections", () => {
  assert.equal(computeTotal({ packageId: "nope", participants: 2, accommodationId: "star3", addons: [] }), null);
  assert.equal(computeTotal({ packageId: "borobudur", participants: 2, accommodationId: "nope", addons: [] }), null);
  assert.equal(computeTotal({ packageId: "borobudur", participants: 2, accommodationId: "star3", addons: ["nope"] }), null);
});

test("the deposit share comes from pricing.json", () => {
  assert.equal(depositShare, 0.3);
  assert.equal(payNowFor(3700000, "full"), 3700000);
  assert.equal(payNowFor(3700000, "dp"), 1110000);
});

test("normaliseAddons sorts, de-duplicates, and rejects unknowns", () => {
  assert.deepEqual(normaliseAddons(["meals", "drone", "meals"]), ["drone", "meals"]);
  assert.deepEqual(normaliseAddons(undefined), []);
  assert.equal(normaliseAddons(["nope"]), null);
  assert.equal(normaliseAddons("drone"), null);
});

test("a well formed payload passes validation", () => {
  const result = validateBookingPayload({ ...base, addonIds: ["drone"] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.addons, ["drone"]);
  assert.equal(result.value.email, "budi@example.com");
});

test("validation rejects each field independently", () => {
  const cases = [
    [{ packageId: "nope" }, "packageId"],
    [{ accommodationId: "nope" }, "accommodationId"],
    [{ paymentType: "half" }, "paymentType"],
    [{ method: "card" }, "method"],
    [{ participants: 0 }, "participants"],
    [{ participants: 31 }, "participants"],
    [{ participants: 2.5 }, "participants"],
    [{ date: "not-a-date" }, "date"],
    [{ date: "2020-01-01" }, "date"],
    [{ name: "B" }, "name"],
    [{ email: "nope" }, "email"],
    [{ phone: "123" }, "phone"],
    [{ idempotencyKey: "short" }, "idempotencyKey"],
    [{ addonIds: ["nope"] }, "addonIds"]
  ];

  for (const [override, field] of cases) {
    const result = validateBookingPayload({ ...base, ...override });
    assert.equal(result.ok, false, `expected ${field} to fail: ${JSON.stringify(override)}`);
    assert.ok(result.errors[field], `expected an error on ${field}`);
  }
});

test("validation strips control characters and collapses whitespace", () => {
  const result = validateBookingPayload({ ...base, name: "  Budi\u0000  Santoso \n " });
  assert.equal(result.ok, true);
  assert.equal(result.value.name, "Budi Santoso");
});

test("validation caps field lengths instead of storing whatever arrives", () => {
  const result = validateBookingPayload({ ...base, notes: "x".repeat(5000) });
  assert.equal(result.ok, true);
  assert.equal(result.value.notes.length, 1000);
});
