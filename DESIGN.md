# Design direction

Direction for the Nusantara Travel landing page. This is the file antislop reads for
direction; `README.md` covers how to run and configure the page.

Source of the direction: the client supplied a Stitch design reference
(`Executive Consulting Website Design Modern Business Strategy UI Concept.jpg`) and asked
for the landing page to follow it. That request is what makes the navy corporate layout a
deliberate brief rather than an unasked-for clone (R-30).

## Design Read

> Reading this as: a tourism marketing landing page for Indonesian and international
> leisure travellers, in the corporate-navy editorial style of the supplied reference,
> dial **ENERGY 2 / RHYTHM 2 / MOTION 1**.

## Identity in one line

A travel operator that behaves like a consultancy: calm navy surfaces, one steel-blue
accent, photographs doing the talking, and numbers always visible before you commit.

## Dials

| Dial | Value | Why |
| --- | --- | --- |
| ENERGY | 2 | The reference is confident but quiet. Big type and real photographs carry the page; no glow, no gradient, no shouting. |
| RHYTHM | 2 | Light and dark sections alternate, and four different internal compositions repeat (card row, split forms, photo mosaic, accordion). Consistent, with deliberate breaks, not uniform. |
| MOTION | 1 | Only hover and focus feedback, plus one smooth scroll from the calculator to the booking form. A travel page whose product is a place should not animate the place away. |

## Palette

| Token | Value | Role | Reason |
| --- | --- | --- | --- |
| `--navy-950/900/800/700` | `#0b1726` … `#1b3454` | Dark surfaces, header, text on light | One hue in four steps. The reference is built on a single deep navy, so a tint ramp from it keeps the page coherent instead of introducing a second dark. |
| `--blue` | `#3d6f9e` | The accent | Steel blue rather than a saturated primary. It reads as a map plate, which is the right register for geography, and it holds 4.97:1 on the paper background for the small uppercase section labels. |
| `--blue-light` | `#7fa8cf` | Accent on dark surfaces | The same accent lifted so it clears the dark bands: 5.70:1 on the darkest card surface and up to 7.22:1 on `--navy-950`. Needed because `--blue` alone is too dark on the dark bands. |
| `--ink` / `--slate` / `--muted` | `#172536`, `#55677a`, `#5f7085` | Body text on light | Navy-tinted greys, not neutral greys, so text belongs to the same family as the surfaces. `--muted` is the lightest grey used for body copy and still measures 4.76:1 on `--paper`. |
| `--paper` / `--white` | `#f5f8fb`, `#ffffff` | Light surfaces | `--paper` is faintly blue, which keeps large white areas from looking like default browser white. |
| `--danger`, `--success-ink`, chip gold | `#a3312b`, `#256b3a`, `#9a7b12` / `#6b5200` | State only | Three semantic state colours, each used in exactly one place: validation errors, the deposit/success state, and the "Pending (demo)" chip. They never appear as decoration. |

Palette accounting against R-29: one core hue (navy, in four tints) plus one accent
(steel blue, in two tints). Greys and white are neutrals and do not count. The three state
colours are part of the system, not extra brand colours, each with a single job.

Every pairing was computed, not eyeballed. Lowest ratios in use: `--muted` on `--paper`
4.76:1, the section label `--blue` on `--paper` 4.97:1, the input border `--line-input` on
white 3.32:1 (non-text), the focus ring 8.54:1 on white and 11.18:1 on navy. All pass AA.

## Typography

**Plus Jakarta Sans**, self-hosted, weights 400 to 800, latin and latin-ext subsets.

Reason: it was designed for Jakarta's city identity by Tokotype, so it is Indonesian by
origin and it is a neutral grotesque with enough character in the `a`, `g`, and `t` to
avoid looking like a placeholder. It also has the full weight range the page needs (400
body, 600 labels, 800 headings) in one family, which keeps the page to a single font
request pair. Inter would have worked but is the default answer, and this was the one
chance to make a choice with a reason. Fallback stack is `system-ui`, `Segoe UI`, `sans-serif`.

Scale: hero `clamp(2.7rem, 6.2vw, 4.9rem)` at 800 with `-0.035em` tracking; section
headings around 2.2rem; body 1rem with 1.5 line height; small meta at 0.76rem. Headings
tighten, body stays loose. Uppercase is reserved for section labels at 0.18em tracking
and for the small card tags, both short strings, so the wide tracking reads as a label
system rather than as decoration (R-06).

## Layout and spacing

- Container `min(1180px, 100% - 48px)`, so the page breathes at 1440 and never touches the
  edge at 390.
- Section padding is 96px vertical. Uniform rhythm is the deliberate choice here; the
  variation lives in the section composition, not in the gaps (RHYTHM 2).
- Breakpoints at 1080, 980, 640, and 420 px. Nothing relies on a single mobile breakpoint.
- The four value cards pull up over the hero with `-72px`, which is the reference's
  overlapping-cards gesture and the page's identity motif. It also does real work: it
  attaches the four promises to the hero image instead of leaving them in a separate band.

## Section composition

Each section has a reason to exist and its own shape:

| Section | Surface | Composition | Reason |
| --- | --- | --- | --- |
| Header | navy | Logo, links, language switch, one CTA | The language switch belongs beside the CTA: both are "how do I proceed" controls. |
| Hero | photo + scrim | Left-aligned headline, two CTAs, payment note | The photo is the product. A two-axis scrim, not a flat gradient, holds the white type above AA across the whole text block. Measured on the rendered pixels (text hidden, background sampled) the worst case is 8.09:1 for the headline at 390px, 5.59:1 for the lead paragraph at 390px, and 10.5:1 for the payment note (R-25). |
| Value propositions | paper, overlapping | Four cards | Four claims, and four is what the brief supports. The icons are drawn to the claim (a
guide flag, a torn receipt, a shield with a check, a calendar with a stretch arrow,
matching "local guides", "transparent pricing", "safe payment", and "flexible dates"),
drawn as inline SVG at 1.6px stroke rather than pulled from a library set (R-04). |
| Package catalog | navy | Three photo cards | Three routes exist. Not a three-tier pricing table, and no "most popular" badge, because the brief does not rank them. |
| Cost calculator | paper | Form left, dark summary right | The estimate is the product decision, so the number gets the dark panel (one focal point per screen). |
| Gallery | white | Six-photo mosaic, first photo spans two columns | A mosaic because the photographs have different shapes; a uniform grid would crop the good parts. |
| Testimonials | paper | Three cards, marked placeholders | Placeholder policy below. |
| Booking | navy | Form left (larger), summary right (smaller) | Mirrors the calculator, so the estimate the user just built is still visible while they fill the form. 1.25fr vs 0.75fr because the form has more fields than the summary has rows. |
| FAQ | paper | Narrow accordion, 860px | Six questions the brief actually asks about, in a single readable column. |
| Footer | navy | Three columns, 1.5fr / 0.8fr / 1fr | Brand statement, in-page links, contact. Not a four-column Product/Company/Resources/Legal template (R-05). |

## Motion

| Element | Motion | Reason |
| --- | --- | --- |
| Links, buttons, cards | Background, colour, and border transitions of 150 to 200 ms | Feedback, so the pointer target answers. |
| Card hover | 2px lift | Confirms which card the pointer is on. |
| Header | Condenses after 24px of scroll | Returns vertical space to the content once the hero is passed. |
| Calculator "Book this estimate" | One smooth scroll to the booking form | Carries the user across the page in the direction the content flows. Becomes an instant jump under `prefers-reduced-motion`. |

No scroll-reveal, no fade-up, no parallax. MOTION 1.

## Placeholders

Everything that would otherwise have to be invented is either omitted or labelled:

- Testimonials are three cards tagged "Contoh" / "Example", with the quote reading
  `[Tulis ulasan asli pelanggan di sini...]`. No invented names, faces, or reviews (R-18).
- No statistics anywhere on the page. No "10k+ travellers", no ratings, no counters (R-17).
- Prices are stated as sample data in the catalog note, the calculator disclaimer, the
  booking summary note, and the footer (R-38).
- The payment step says "Pending (demo)" and "No payment was processed" in plain text.
- The photography is real, licensed, and credited in `credits.html`. No AI imagery.
- The brand mark is a drawn two-peak monogram created for this demo. It is the one asset
  the brief did not specify, so it is a placeholder-quality mark intended for replacement,
  not a finished identity.

## Why this is not a generic template

Swap out the logo and the page still reads as this business: the estimate panel that
carries the number into the booking summary, the four promises sitting on the hero image,
the Indonesian place names doing the selling, and the navy/steel-blue register taken from
the supplied reference. The structure is driven by what a tour booking actually needs
(package, group size, accommodation, add-ons, date, payment method), not by the standard
hero-cards-testimonials-FAQ order.
