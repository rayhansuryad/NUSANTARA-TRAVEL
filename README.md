# Nusantara Travel, landing page demo

A multi-language marketing landing page for a fictional Indonesian tour operator,
with a working booking and payment path behind it. Built from the brief in
`prd_landing_page_pemasaran_pariwisata.md`, styled after the supplied design
reference.

The page itself is still three source files plus assets, with no build step and no
framework. The booking API adds four serverless handlers and two dependencies,
neither of which is needed to look at the design.

## Run it

### The whole thing, including the payment API

This serves the static page, the API handlers, and a local stand-in for the
Midtrans API in one process. No Midtrans account and no database server needed:
without `DATABASE_URL` it stores bookings in a SQLite file at `.data/bookings.db`.

```powershell
npm install
npm run dev
# page          http://127.0.0.1:8787/index.html
# mock gateway  http://127.0.0.1:8788
```

The page opens in demo mode until it is told an API exists, so for this to take
real bookings the page has to point at the API. Two ways:

```js
// assets/js/main.js, CONFIG
apiBase: ""        // same origin, the default once you deploy
```

```html
<!-- or, without touching main.js, before that script runs -->
<script>window.NT_API_BASE = "";</script>
```

While `CONFIG.apiBase` is `null` the page stays a labelled demo: no request
leaves the browser, the payment panel stays hidden, and the disclaimer says so.

Post a booking, then settle it without paying:

```
http://127.0.0.1:8788/settle?order=<CODE>&status=settlement
```

Other statuses the mock accepts: `capture`, `expire`, `deny`, `cancel`, `refund`.
Add `&times=3` to replay a notification, which is how the duplicate handling is
checked.

### Just the page

Serve the folder over HTTP. Do not open `index.html` with a double click.

```powershell
npx --yes serve .
```

Any static server works (`python -m http.server`, `php -S`, nginx, a CDN). This is
enough to see the design, the calculator, and the demo checkout.

**Why HTTP matters.** Browsers block `file://` pages from reading the self-hosted
`.woff2` fonts (the file origin is `null`, so the font request is treated as cross-origin
and fails). Opened directly from disk the page still renders, but it falls back to the
system sans instead of Plus Jakarta Sans. Serving over HTTP fixes it. This was the only
console error found during verification.

## What is in here

```
index.html                 the page, all sections, inline SVG icons
credits.html               photo attributions and the font licence
assets/data/pricing.json   every price, shared by the page and the server
assets/css/styles.css      design tokens, layout, responsive rules
assets/js/i18n.js          ID and EN dictionaries plus the t() helper
assets/js/main.js          calculator, booking, payment panel, language, lightbox
assets/fonts/*.woff2       Plus Jakarta Sans, latin and latin-ext subsets
assets/img/*.jpg           photographs (Wikimedia Commons, see credits.html)
assets/img/favicon.svg     brand mark favicon

api/bookings/index.js      POST /api/bookings, create a booking and a charge
api/bookings/status.js     GET  /api/bookings/status?code=, payment state
api/webhooks/midtrans.js   POST /api/webhooks/midtrans, the source of truth
api/cron/reconcile.js      GET  /api/cron/reconcile, reconcile and raise balances

lib/pricing.js             reads pricing.json, prices a selection, deposit maths
lib/validate.js            rejects anything the database or gateway should not see
lib/midtrans.js            Core API client, signature check, status mapping
lib/booking.js             create, replay, raise the balance, apply a notification
lib/notify.js              hands the balance message to BALANCE_NOTIFY_URL, or logs it
lib/db.js                  Postgres in production, SQLite locally, one interface
lib/http.js                body parsing, JSON responses, rate limit, CORS

server/app.js              routes the four handlers plus static files
server/dev.js              local dev entry point
server/mock-midtrans.js    a stand-in for api.sandbox.midtrans.com

test/*.test.js             49 tests: pricing, validation, and the full money path
vercel.json                daily reconcile cron
```

There is still no build step and no framework. `npm install` pulls one
dependency, `pg`, and only for production.

## Replace these before going live

Everything below is demo content. The page says so in the footer and in the section
notes, so nothing here should be mistaken for a real offer.

| What | Where | Current demo value |
| --- | --- | --- |
| WhatsApp number | `assets/js/main.js`, `CONFIG.whatsappNumber` | `6281200000000` |
| WhatsApp number in markup | `index.html`, `#wa-float` and `#footer-wa` hrefs | `https://wa.me/6281200000000` |
| Email | `index.html`, footer `mailto:` link | `hello@nusantaratravel.example` |
| Base package prices | `assets/data/pricing.json`, `packages[].price` | `1850000` to `6750000` |
| Accommodation multipliers | `assets/data/pricing.json`, `accommodation[].multiplier` | `0.85` to `1.55` |
| Add-on prices | `assets/data/pricing.json`, `addons[].price` | `150000` to `750000` |
| Deposit share | `assets/data/pricing.json`, `depositShare` | `0.3` |
| Testimonials | `index.html`, `#testimoni` | three cards marked "Contoh" / "Example" |
| Payment methods strip | `index.html`, `#testimoni` footer | the two methods the page can actually settle |
| Map and location line | `index.html`, footer | `Labuan Bajo, Nusa Tenggara Timur` |
| Bank for virtual accounts | `.env`, `MIDTRANS_BANK` | `bca` |

The price on each package card is also written into `index.html` as static markup,
so the cards render with JavaScript disabled. `syncPackagePrices()` rewrites those
three numbers from `pricing.json` as soon as the page is live, which means a
changed price stays correct for everyone except a visitor with scripts off.

The three testimonials are visibly marked placeholders, never invented reviews. Each card
carries a "Contoh" / "Example" tag, and the quotes read
`[Tulis ulasan asli pelanggan di sini...]`. If you have real quotes, replace those three
fields (`testimonials.quote`, `testimonials.name`, `testimonials.meta`) in both
dictionaries, then drop `testimonials.badge` and `testimonials.note`.

## Payments

The payment flow is wired end to end against Midtrans, with the Core API rather
than Snap. Core API is the right choice here because the page renders the virtual
account number and the QR image inline instead of sending the customer to a
hosted page. Snap cannot do that, and the two channels that would need a redirect
(e-wallets, cards) are deliberately not offered. Offering a method the checkout
cannot settle is worse than not listing it.

### How a booking flows

```
browser                server                        Midtrans
  |  POST /api/bookings -->|                              |
  |                        |-- price from pricing.json    |
  |                        |-- reject if the displayed total moved
  |                        |-- insert row (reserves idempotency key)
  |                        |-- POST /v2/charge ---------->|
  |                        |<-- VA number or QR URL ------|
  |                        |-- store the instructions     |
  |<-- code, amount, VA ---|                              |
  |                                                       |
  |                        |<-- POST /api/webhooks/midtrans
  |  GET /api/bookings/status?code=...                    |
  |<-- pending | paid | expired | failed | refunded ------|
```

### Who is allowed to say what

These are the rules that keep the numbers honest:

- **The browser never sends a price.** It sends the selection (package, travellers,
  accommodation, add-ons, payment choice). The server prices it from
  `assets/data/pricing.json`, the same file the page reads.
- **The displayed total is checked, not trusted.** The page also sends what it
  showed the customer. If they disagree the server answers `409 pricing_changed`
  instead of charging a number nobody saw.
- **The webhook is the only source of truth.** The client callback and the status
  poll are hints. Money is recorded as received when a signed notification says so.
- **Notifications are verified twice.** The SHA-512 `signature_key` proves Midtrans
  sent it. The amount is then compared against the stored booking, because a
  signature over a different transaction is still a valid signature.
- **Status only moves forward.** `paid` can become `refunded`. Nothing else drags
  it backwards, so a late duplicate `pending` cannot unpay a booking. An unknown
  `transaction_status` is ignored rather than guessed at.
- **One idempotency key, one booking.** Concurrent submits share a result, and a
  key that never produced payment instructions is released for reuse.

### Set it up

1. **Get Midtrans keys.** Create a sandbox account, then copy the server key from
   Settings, Access Keys. Sandbox keys start with `SB-Mid-server-`. The server
   refuses to start if the key prefix and `MIDTRANS_ENV` disagree, because that
   mistake is otherwise silent.

2. **Create a Postgres database.** Neon and Supabase both have a free tier. Copy
   the connection string into `DATABASE_URL`. Without it the app falls back to
   SQLite, which is fine locally and wrong in production, since serverless
   instances do not share a disk. The tables are created on first use.

3. **Deploy.** Everything is on Vercel already: static files at the root, the four
   handlers in `api/`, and the cron in `vercel.json`. Point the project at the
   repository and deploy.

4. **Set the environment variables** in the hosting dashboard:

   ```
   MIDTRANS_ENV=sandbox
   MIDTRANS_SERVER_KEY=SB-Mid-server-...
   MIDTRANS_BANK=bca
   MIDTRANS_EXPIRY_HOURS=24
   BALANCE_LEAD_DAYS=14
   DATABASE_URL=postgresql://...
   CRON_SECRET=<a random string>
   ```

   `BALANCE_NOTIFY_URL` and `PUBLIC_BASE_URL` are optional and only affect the
   balance message; see "Collecting the balance" below. Never prefix the server
   key with `VITE_` or `NEXT_PUBLIC_`. Any prefix like that ships the key to every
   visitor.

5. **Tell the page about the API.** Set `CONFIG.apiBase` to `""` in
   `assets/js/main.js` and redeploy. The disclaimer and the success note switch
   from the demo wording to the live wording on their own.

6. **Register the webhook.** In the Midtrans dashboard, set the Payment
   Notification URL to `https://your-domain/api/webhooks/midtrans`. On your
   machine, a tunnel (`ngrok http 8787`) gives you a public URL pointing at
   `server/dev.js`.

7. **Test it in sandbox.** Book something, then open the Simulator in the Midtrans
   dashboard and send a `settlement` notification for that order id. The status
   chip should move to Paid without a reload. Locally, the mock's `/settle` route
   does the same thing.

8. **Go live** by switching `MIDTRANS_ENV` to `production` and swapping in the
   production key. The prefix check will catch a half finished switch.

### The two choices the customer makes

| Radio group | Stored value | Rendered as |
| --- | --- | --- |
| `name="paymentType"` | `full` or `dp` | "Pay in full" / "30% deposit" |
| `name="method"` | `va` or `qris` | the same label as the form |

`gross_amount` sent to the gateway is the amount due now, so a deposit booking
charges 30 percent of the total, not the total. The deposit share lives once, in
`pricing.json`, and both the page and the server read it from there.

Both values appear in the booking summary, the success panel, and the copied
summary text. The labels are derived from the stored value through `t()` on every
render, so switching language updates all three together.

### Status states

| Booking status | Shown as | Set by |
| --- | --- | --- |
| `pending` | Awaiting payment | charge response, `pending` |
| `paid` | Paid | `settlement`, or `capture` with `fraud_status: accept` |
| `expired` | Expired | `expire`, or the local countdown passing |
| `failed` | Failed | `deny`, `cancel`, or a charge that errored |
| `refunded` | Refunded | `refund`, `partial_refund` |

### Collecting the balance

A deposit booking still owes the rest, and that debt is collected by a second
virtual account raised on its own:

1. The deposit is paid. Nothing is raised before that, because invoicing a balance
   to someone who has paid nothing puts a second live account in front of them.
2. The scheduled job looks for deposit bookings whose trip date is within
   `BALANCE_LEAD_DAYS` of today.
3. It claims the booking with a conditional update, so two cron instances cannot
   both raise one, then charges the remainder under a new order id, `<CODE>-BAL`.
4. It sends a message to `BALANCE_NOTIFY_URL` if one is set.
5. The customer sees the balance in the success panel: its own status chip,
   amount, account number or QR, and a countdown. The page keeps polling while
   either window is open.

If the gateway refuses the charge, the claim is handed back and the next run
tries again, so a transient outage heals itself. After five attempts it stops and
leaves the booking for a person rather than retrying forever.

Claiming spans two writes (claim, then store the account) and a charge, so a
process that dies in the middle would strand the balance: claimed, not payable,
never retried. A claim older than 15 minutes is therefore treated as abandoned
and the next run finishes it. A claim inside that window is left alone, so a run
that is merely slow is not charged twice.

The balance is stored as its own record (`balance_status`, `balance_va_number`,
`balance_expires_at`, `balance_paid_at`). A settlement for `<CODE>-BAL` moves the
balance to paid and leaves the deposit untouched. A balance whose window closes
with no notification reads as expired, again without touching the deposit.

### Still missing on the payment side

- **Nobody is emailed until `BALANCE_NOTIFY_URL` is set.** There is no email
  provider in this project. With no URL the full message is logged, which means a
  balance can be raised and paid while the customer is never told. Set the URL
  before relying on it.
- **One bank only.** `MIDTRANS_BANK` picks a single bank for every virtual account.
  Multiple banks means a bank selector in the form and a `bank` field in the
  payload; the request shape is identical for `bca`, `bni`, `bri` and `permata`.
- **Mandiri is not wired.** It uses the `echannel` request shape and returns a
  biller code plus a bill key, which needs a different block in the payment panel.
- **No automated refunds.** A refund is reflected when Midtrans reports one; the
  page never asks for one.
- **The rate limiter is per instance.** Ten booking attempts per minute per IP.
  Serverless instances do not share memory, so a real flood needs a shared store.
- **The status route is public.** Anyone holding a code can read that booking's
  payment state. The code is 8 characters from a 32 character alphabet, and the
  response carries no name, email, phone or notes.

## Deploying

Vercel reads the repository as it stands: static files from the root, `api/*.js` as
functions, `vercel.json` for the cron. Nothing is compiled.

`lib/`, `server/`, and `test/` are ordinary files and are not turned into
functions. `server/dev.js` and `server/mock-midtrans.js` are for local use only;
they never run in production.

The reconcile cron runs once a day on the free plan and does two jobs. It
re-checks bookings that have sat at `pending` for more than half an hour and asks
Midtrans what really happened, which covers a notification that was lost. It also
raises the balance for deposit bookings that have entered their lead window. If a
day of lag is too long for either, point an uptime pinger at
`/api/cron/reconcile` hourly with the `x-cron-secret` header.

### Moving to Cloudflare Workers

`lib/` is platform neutral and needs no changes. Only the handler signatures do,
from `(req, res)` to `Request`/`Response`, plus swapping `lib/db.js` for D1 and
`node:crypto` for Web Crypto. Vercel and Neon were chosen because they need no
adaptation at all.

## Tests

```powershell
npm test
```

49 tests, all touching the real handlers over real HTTP against the mocked
gateway. They cover the pricing and validation rules, then the whole money path:
that the server prices a selection itself, that it refuses a stale total, that
concurrent submits produce one booking, that a forged signature changes nothing,
that a correctly signed notification for the wrong amount is ignored, that a paid
booking is never dragged back to pending, that a repeated notification is
harmless, and that the reconcile cron repairs a booking whose notification was
lost.

The balance has its own set: that nothing is raised before the deposit is paid or
before the lead window opens, that one run raises one account and a second run
raises none, that a raise still in flight is not started twice while an abandoned
one is finished, that settling `<CODE>-BAL` pays the balance and leaves the deposit
alone, that a signed notification for the deposit amount cannot settle the
balance, that an expired balance reads as expired, and that a gateway failure
hands the claim back so the next run succeeds.

The browser side is verified separately, against the same handlers, with a
headless Chrome driving the form: the displayed amount, the amount the server
charged, and the amount on the virtual account all have to agree, and the payment
panel has to translate and tear down cleanly. Those harnesses live outside the
repository and are not part of `npm test`.

## Analytics

Not wired up, by design. The page sends nothing anywhere.

- GA4: add the `gtag.js` snippet in `index.html` `<head>` and fire events at the
  points that matter: `calc_book` on `#calc-book`, `booking_submit` on a
  successful submit, `payment_pending` after a virtual account is shown,
  `payment_settled` when the status poll reports `paid`, `gallery_open` in
  `openLightbox`, `language_switch` in `setLanguage`.
- Meta Pixel: same moments, plus a `PageView` on load.
- Do not send the customer's name, email, or phone to either tool. The booking
  code is enough to join a conversion to a server side record.
- If you add either, the footer privacy note has to change with them, and so does
  the consent text next to the submit button.

## Images

Twelve photographs, all free licences, all listed with author and licence in
`credits.html`. They are Wikimedia Commons downloads resized to 1280 px wide (the hero
to 1920 px) and saved as JPEG.

**Still to do:** convert them to WebP. No WebP encoder was available on the build
machine, so the PRD's WebP requirement is not met yet. Any of these works:

```powershell
npx --yes sharp-cli --input assets/img --output assets/img   # or use cwebp / ffmpeg / squoosh
```

Then swap the extensions in `index.html` (the `<img>` tags, `data-full` on the gallery
buttons, and `og:image`) and keep the JPEGs as the fallback inside `<picture>` if you
want to support older browsers.

The ten content photos carry `width`/`height` to reserve layout space, and `loading="lazy"`
except the hero, which is `fetchpriority="high"`. The lightbox image at the end of the
document is sized by CSS and loads only when a photo is opened.

## Language switching

- Order of precedence: `?lang=en` in the URL, then `localStorage` (`nt-lang`), then
  `navigator.language`.
- The switch writes back to `localStorage` and updates the URL with
  `history.replaceState`, so `?lang=en` is a shareable link.
- Text lives in `assets/js/i18n.js`. Markup hooks are `data-i18n` (text),
  `data-i18n-placeholder`, `data-i18n-aria`, `data-i18n-alt`, `data-i18n-title`.
- Adding a language means adding one dictionary block and one button in `.lang-switch`.
  Keys are flat. Both dictionaries currently hold 221 keys and match exactly.

## Accessibility notes

- Skip link, landmark regions, and a labelled form.
- The gallery lightbox is a modal dialog: Escape closes, arrow keys move between photos,
  Tab is trapped on the three controls, and focus returns to the thumbnail it opened from.
- Validation errors are text, tied to their inputs with `aria-describedby`, and focus
  moves to the first invalid field.
- Focus rings are custom and visible on both light and dark surfaces.
- `prefers-reduced-motion` is respected: the smooth scroll becomes an instant jump.

## Before launch

Everything here is placeholder content, so the list is short but not empty.

- **A privacy policy and a consent checkbox.** The form collects a name, an email,
  a phone number, and free text notes, and posts them to your server. Indonesian
  law (UU PDP) expects a stated purpose and a consent step, neither of which
  exists yet. The demo disclaimer says only that nothing is processed.
- **Real contact details.** The WhatsApp number, the email address, and the map
  line are all fabricated. See the table above.
- **WebP images.** See the Images section.
- **A second bank, or a bank selector.** `MIDTRANS_BANK` picks one.
- **The balance message.** It is prepared and logged, but not delivered until
  `BALANCE_NOTIFY_URL` points at an email endpoint.
- **Analytics, if you want them.** The page currently measures nothing, which is
  also the safest default while the privacy policy is missing.

## Browser support

Any current Chrome, Edge, Firefox, or Safari. Uses `:has()` and `Number.isFinite`, both
widely supported. No transpiling.
#   N U S A N T A R A - T R A V E L  
 #   N U S A N T A R A - T R A V E L  
 