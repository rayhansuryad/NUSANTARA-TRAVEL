import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/* The single price table, shared with the browser. Read once per cold start:
   it is a few hundred bytes and cannot change inside a deployment. */
const PRICING_PATH = path.join(here, "..", "assets", "data", "pricing.json");
const pricing = JSON.parse(readFileSync(PRICING_PATH, "utf8"));

const packages = new Map(pricing.packages.map((entry) => [entry.id, entry]));
const tiers = new Map(pricing.accommodation.map((entry) => [entry.id, entry]));
const addonTable = new Map(pricing.addons.map((entry) => [entry.id, entry]));

export const depositShare =
  typeof pricing.depositShare === "number" ? pricing.depositShare : 0.3;

export const packageIds = [...packages.keys()];
export const accommodationIds = [...tiers.keys()];
export const addonIds = [...addonTable.keys()];

/* Methods the payment gateway can actually settle. Anything else is a
   request we cannot honour. */
export const supportedMethods = ["va", "qris"];
export const supportedPaymentTypes = ["full", "dp"];
export const maxParticipants = 30;

export function isKnownPackage(id) {
  return packages.has(id);
}

export function isKnownAccommodation(id) {
  return tiers.has(id);
}

export function isKnownAddon(id) {
  return addonTable.has(id);
}

/*
 * Mirrors computeEstimate() in assets/js/main.js on purpose. If you change the
 * maths in one place, change it in the other, and the parity test in
 * test/pricing.test.js will tell you when you forget.
 */
export function computeTotal({ packageId, participants, accommodationId, addons }) {
  const pkg = packages.get(packageId);
  const tier = tiers.get(accommodationId);
  if (!pkg || !tier) return null;

  const basePerPerson = pkg.price * tier.multiplier;
  const baseTotal = basePerPerson * participants;

  let addonPerPerson = 0;
  let addonOnce = 0;

  for (const id of addons) {
    const addon = addonTable.get(id);
    if (!addon) return null;
    if (addon.per === "person") addonPerPerson += addon.price;
    else addonOnce += addon.price;
  }

  const addonTotal = addonPerPerson * participants + addonOnce;

  return {
    total: Math.round(baseTotal + addonTotal),
    basePerPerson: Math.round(basePerPerson),
    addonTotal: Math.round(addonTotal)
  };
}

export function payNowFor(total, paymentType) {
  const share = paymentType === "dp" ? depositShare : 1;
  return Math.round(total * share);
}

/* What a deposit booking still owes once the deposit has been paid. Zero for a
   booking paid in full, which is what keeps the balance machinery inert there. */
export function balanceFor(total, paymentType) {
  if (paymentType !== "dp") return 0;
  return total - payNowFor(total, paymentType);
}

/* Normalises a list of add-on ids: de-duplicated, order-independent, and with
   anything unknown rejected rather than silently dropped. */
export function normaliseAddons(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const id of input) {
    if (typeof id !== "string" || !addonTable.has(id)) return null;
    if (!out.includes(id)) out.push(id);
  }
  return out.sort();
}
