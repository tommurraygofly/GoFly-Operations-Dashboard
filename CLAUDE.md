# GoFly Operations Dashboard

Private internal operations dashboard for GoFly Aviation, a recreational flight school at
Caloundra Airport (YCDR), Queensland. The user is Tom Murray, Operations Manager and Senior
Instructor. It is separate from the public GoFly website.

## Where things are

- `public/index.html`: the entire app (HTML, CSS and JavaScript in one file, no build step).
- `wrangler.jsonc`: Cloudflare Workers config, Worker name `gofly-ops`, serves `./public` as static
  assets (binding `ASSETS`) with `src/worker.js` as the Worker.
- `src/worker.js`: two API routes. `GET /api/wx?ids=YBSU` fetches the latest METAR and TAF from
  aviationweather.gov (public, no key), cached 2 minutes. `GET/POST /api/sync` reads and writes
  shared records in the D1 database `gofly-ops` (binding `DB`, Oceania, id in `wrangler.jsonc`).
  The `records` table is created on first use. Everything else is served from `./public`. Check
  config changes with `wrangler deploy --dry-run`; test locally with `wrangler dev --local`.
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
  The one exception is the instructor check intervals Tom gave (RAAus), which are editable in
  settings:
  - S&P (Standards and Proficiency) check every 90 days for every instructor (`spDays`).
  - Instructor renewal every 24 months for Junior instructors (`renewJuniorMonths`).
  - Senior instructor renewal every 12 months for Senior, Supervising Senior, DCFI and CFI
    (`renewSeniorMonths`).
  Next due = last completed + interval (`spDue`, `renewDue`); a renewal expiry typed from the
  certificate (`renewalExpiry`) overrides the calculated date. Warning windows: `dueSoonDays`
  for S&P, `renewWarnDays` (30) for renewals.
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
   `gofly-ops:v1`, the local copy on each device.
3b. **Shared sync** (after the data model): every record syncs on its own through `/api/sync`
   (key `coll/id`, settings as `settings/main`; `userName` and `theme` stay per device).
   `persist()` calls `trackChanges()`, which queues differences from the last known server copy
   (`gofly-ops:sync` in localStorage: base, pending, since). Only runs once signed in. `pushNow()` sends, `pullNow()`
   fetches every 20 s and on focus/online. Unsent local edits aren't overwritten; last write wins
   per record. Remote changes update objects in place and re-render via `scheduleRender()`, which
   waits while a form is open or someone is typing. First connection on a device (`startSync`):
   empty database is seeded from the device; otherwise the device takes the shared data and adds
   its own non-example records the database lacks (old copy kept in `gofly-ops:v1:pre-sync`).
   Import, Erase everything and Clear example data affect everyone once synced. The header pill
   shows Synced / Syncing / Offline / This device only.
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
   Instructor profiles: `grade` (junior, senior, supervising, dcfi, cfi), `raausNo`, `lastCheck`
   (last S&P), `lastRenewal`, `renewalExpiry`, `checks` history (logged with `logCheck`, shown in
   `openInstructor`). Old free-text `role` values are mapped to a grade in `normalise()`.
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

## Sign-in, sharing and identity

- Sign-in is required every time the dashboard opens (nothing remembered). No accounts: choose a
  name (Tom, Damien, Anne-Maree; `USERS` in the page and `NAMES` in the Worker, keep both in
  step) and enter the team PIN (7788). `POST /api/login` checks it against the Worker variable
  `GOFLY_PIN` (default 7788; `keep_vars` keeps a value set in the Cloudflare dashboard). If the
  Worker can't be reached, the page checks a SHA-256 hash of 7788 (`PIN_SHA256`).
- The signed-in name (`Who`) is the greeting name and is stamped on every change (`updatedBy`).
  The header button shows who is signed in and switches person or locks (`lockApp`).
- `/api/sync` requires headers `X-GoFly-User` (a known name) and `X-GoFly-Pin`, and stores the
  name as `updated_by`. Nothing renders and nothing syncs until someone signs in.
- A 4-digit PIN is light protection; keep Cloudflare Access in front of the site. Optional
  stronger check: set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` and the Worker also requires a valid
  Access token.

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
