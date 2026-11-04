# GoFly Operations Dashboard

Private internal operations dashboard for GoFly Aviation, a recreational flight school at
Caloundra Airport (YCDR), Queensland. The user is Tom Murray, Operations Manager and Senior
Instructor. It is separate from the public GoFly website.

## Where things are

- `public/index.html`: the entire app (HTML, CSS and JavaScript in one file, no build step).
- `wrangler.jsonc`: Cloudflare Workers config, Worker name `gofly-ops`, serves `./public` as static
  assets (binding `ASSETS`) with `src/worker.js` as the Worker.
- `src/worker.js`: one API route, `GET /api/wx?ids=YBSU`, which fetches the latest METAR and TAF
  from aviationweather.gov (public, no key) and caches them for 2 minutes. Everything else is
  served from `./public`. Check config changes with `wrangler deploy --dry-run`.
- Deployment: Cloudflare Workers Builds is connected to this GitHub repo. Every push to `main`
  deploys to production. Tom's standing instruction: commit and push every finished change
  straight to `main` (no preview branches), after the checks in "Before pushing" pass.
- Access: the workers.dev and preview URLs sit behind Cloudflare Access (authorised emails only).
  Keep it private. Never add public links or sharing.

## Working with Tom

- Usually on his phone. Keep explanations short and practical. Explain your approach briefly,
  then make sensible decisions instead of asking long lists of questions.
- Keep version 1 focused. Integrations and extra features come later, when he asks.

## Hard requirements

- Colours: orange #F15A26, black, white and greys. Status colours (red overdue, orange due soon,
  green complete, dashed grey missing info) are used only for badges and status bands.
- Australian dates (dd/mm/yyyy), Brisbane time (Australia/Brisbane, AEST, no daylight saving),
  litres, decimal hours to one place.
- Never invent compliance rules or calculate due dates. Tom enters all dates and requirements.
- Engine hours and air time are separate counters. Each maintenance item chooses which one it
  counts against (or calendar date only). Each aircraft can set its own hours warning
  (`aircraft.hoursWarn`); blank means use `settings.hoursWarn`. Use `warnFor(ac)`.
- IOR fuel tank (Tom's figures): max safe fill 5,000 L (`settings.tankCapacity`), reorder level
  1,500 L (`settings.fuelThreshold`), standard order 3,500 L (`settings.orderTemplate.litres`).
  "Refill" means the delivery is in the tank: it logs a new reading of latest + 3,500 L and marks
  the open order delivered (with undo). 5,000 L is a hard maximum: readings above it can't be
  saved, a refill that won't fit is blocked (it offers to log the actual level instead), and the
  gauge and graph scale stop at 5,000 L.
- Overview shows a large clock: Brisbane local time with seconds, UTC underneath (24-hour).
- YBSU METAR and TAF widget near the top. Always labelled as not an official briefing (check
  NAIPS). Decode only what the report says; never invent or forecast weather. YCDR has no
  METAR/TAF, so YBSU is the source.
- YCDR runway wind diagram (`windDiagram()`): runways 05/23 and 12/30, both 735 m, drawn to scale
  north-up from settings `rwy05Mag`/`rwy12Mag` (magnetic, default 050/120) plus `magVar`
  (default 11° E), since METAR wind is true. Shows head/crosswind per runway and highlights the
  runway end with most headwind. Labelled as YBSU wind. No crosswind limits unless Tom gives them.
- Calendar deadlines (`dueSoonDays`) and hour-based warnings are reported separately. Low fuel is
  "Low stock", never "Overdue". Ordered fuel is not added to stock until a new reading is logged.
- Charts show hours remaining, not percentages, unless interval and start reading are known. No
  invented trends: the fuel chart only plots logged readings. The tank gauge and graph share the
  same 0 to max-safe-fill scale so their reorder and max lines line up.
- Example data must stay clearly labelled (`example: true`, shown as an "Example" chip) and be
  removable with "Clear example data". Editing an example record makes it a real record.
- Works on desktop, tablet and phone (bottom tab bar under 760px), light and dark mode.

## Fleet

Aircraft identifiers: 7788, 1675, 8582, 8515, 8514. Tom has said 1675 is a Sling 2 with Garmin
G3X, 8515 is a Sling 2 with MGL, and 8514 is a temporary or loan Sling.

## Code structure (inside `public/index.html`)

The script is split into numbered sections:

1. **Utilities**: Brisbane date helpers (`todayISO`, `daysUntil`, `fmtDate`, `fmtStamp`), formatting.
2. **Storage adapter**: `LocalAdapter` with `load()` and `save(data)` using localStorage key
   `gofly-ops:v1`. `Store.adapter` is the single swap point for a Cloudflare D1 backend.
3. **Data model**: `emptyState()`, `normalise()` (migration, always keeps the five aircraft),
   `applyExamples()`, `clearExamples()`. State lives in `S`. Collections: `aircraft`,
   `maintenance`, `defects`, `fuelReadings`, `fuelOrders`, `fuelIssues`, `instructors`, `tasks`,
   plus `settings` (userName, theme, dueSoonDays, hoursWarn, fuelThreshold, tankCapacity,
   orderTemplate) and `meta`.
4. **Rules**: all overdue, due soon and missing-info logic (`dateStatus`, `maintStatus`,
   `orderStatus`, `checkState`, `attentionItems`, `upcoming`, `waitingItems`, `waitingGroups`,
   `hourItemFor`). Change status logic here only. `attentionItems()` is the single source for the
   overview cards, the Priority actions list and the tab badges, so counts always agree. Each item
   has `sev` (overdue, alert, low, soon, missing, info), `src`, `basis` ('date' or 'hours') and
   `area` (tab).
5. **Schemas**: field lists in `SCHEMAS` generate every add/edit form via `openEditor(kind, id)`.
   To add a field, add it to the schema; the form, saving and validation follow.
6. **Views**: overview = summary cards, `maintChart()` (HTML bars, one hours scale),
   `fuelSummary()` (SVG line drawn at real width by `drawCharts()`, tap or arrow keys to read
   values), Priority actions (top 5), instructor rows, aircraft cards, Waiting on, Coming up.
   `renderOverview`, `renderAircraft`, `renderFuel`, `renderInstructors`,
   `renderTasks`. Hash routing (`#overview`, `#aircraft`, `#fuel`, `#instructors`, `#tasks`).
   Click handlers use `data-act` (the `ACT` map) or `data-reg` (functions registered per render).

Other conventions: every record gets `id`, `createdAt`, `updatedAt`, `updatedBy`, and `archived`
where archivable. Changes go through `commit()` (save and re-render). Use `withUndo()` for
complete, archive and delete. Escape all user text with `esc()`. Fuel order template defaults to
3,500 L Premium Unleaded 98 from IOR. Export/import of JSON backups is in Data & settings.

## Current limitation and likely next step

Records are saved per browser, so phone and computer don't share data. The planned next step is
a Cloudflare D1 database with a small Worker API, keeping the same `load()`/`save()` shape (or a
per-record API), plus a one-off import of Tom's exported backup. Check identity via the
Cloudflare Access JWT before allowing writes.

## Look and feel

GoFly-branded tiles and widgets. Logos and app icons are in `public/brand/` (made from Tom's
supplied logos; `gofly-logo-dark-bg.png` for black backgrounds, `gofly-logo-light-bg.png` for
light). Black header and an overview welcome band with an overall status (Action needed / Watch /
All clear), summary tiles tinted red or orange when they need attention, and widgets with icon
headings (`ICO(name)`, icons in `ICONS`). Inter for text; Barlow Condensed bold italic uppercase
for headings and aircraft idents, echoing the logo. Status shown by colour plus icon plus words
(red action/overdue, orange watch/due soon/low stock, green OK, dashed grey not entered). The
GoFly website is for information only; don't copy its theme. Touch targets about 44px.

## Before pushing

- Keep everything in the one HTML file unless there's a clear reason to split it.
- Check the page still loads without console errors and fits 390px, 768px and 1440px widths.
- Write a plain-English commit message that says what changed for Tom.
