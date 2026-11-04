# GoFly Operations Dashboard

Private internal operations dashboard for GoFly Aviation, a recreational flight school at
Caloundra Airport (YCDR), Queensland. The user is Tom Murray, Operations Manager and Senior
Instructor. It is separate from the public GoFly website.

## Where things are

- `public/index.html`: the entire app (HTML, CSS and JavaScript in one file, no build step).
- `wrangler.jsonc`: Cloudflare Workers config, Worker name `gofly-ops`, serves `./public` as static
  assets (binding `ASSETS`) with `src/worker.js` as the Worker.
- `src/worker.js`: API routes (also `/api/login`, `/api/logout`, `/api/files` for defect photos). `GET /api/wx?ids=YBSU` fetches the latest METAR and TAF from
  aviationweather.gov (public, no key), cached 2 minutes. `GET/POST /api/sync` reads and writes
  shared records in the D1 database `gofly-ops` (binding `DB`, Oceania, id in `wrangler.jsonc`).
  The `records` table is created on first use. Everything else is served from `./public`. Check
  config changes with `wrangler deploy --dry-run`; test locally with `wrangler dev --local`.
- Deployment: Cloudflare Workers Builds is connected to this GitHub repo. Every push to `main`
  deploys to production. Tom's standing instruction: commit and push every finished change
  straight to `main` (no preview branches), after the checks in "Before pushing" pass.
- Access: Tom chose to turn Cloudflare Access off. The PIN sign-in is the only lock, so never put
  the PIN in code, docs or commits (it lives only in the Cloudflare secret `GOFLY_PIN`). The GitHub
  repo is public. Never add public links or sharing.

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
  - Junior: S&P (Standards and Proficiency) check every 90 days (`spDays`) and instructor
    renewal every 24 months (`renewJuniorMonths`).
  - Senior and Supervising Senior: SI flight review every 12 months (`renewSeniorMonths`).
  - DCFI and CFI: SI flight review every 24 months (`renewChiefMonths`).
  - S&P checks are juniors only (`needsSP`); senior grades show "Not required".
  Next due = last completed + interval (`spDue`, `renewDue`); an expiry typed from the
  certificate (`renewalExpiry`) overrides the calculated date. Warning windows: `dueSoonDays`
  for S&P, `renewWarnDays` (30) for renewals and SI flight reviews.
- Instructor expiries (`EXPIRIES`, `expState`): RAAus membership and CASA medical are mandatory
  (missing = flagged); first aid and CPR are optional (tracked once entered). Plus free-form
  "other expiries" (`quals`). Warning window `expiryWarnDays` (30).
- Aircraft registration and insurance expiries (`regoExpiry`, `insuranceExpiry`, `acExpiries`),
  entered by Tom; missing = flagged. Never infer availability from them. Cross-hired aircraft
  can set insurance to N/A (`insuranceNA: 'yes'`), which stops insurance being flagged.
- Documents and compliance (Docs tab, collection `documents`, `renderDocs`, `docState`): each
  document has a type (`DOC_CATS`), tracks an expiry or a next review date (Tom enters it), and
  an optional review interval in months that "Mark reviewed" uses to set the next date.
  Warning window `docWarnDays` (30). The Worker's `COLLS` must include every synced collection.
- Engine hours and air time are separate counters. Each maintenance item chooses which one it
  counts against (or calendar date only).
- Hour-based maintenance levels, the same for every aircraft (`hoursState`, `hrsLevels`):
  green "Good" above 50 hrs left, amber "Book soon" at 50 or fewer (`settings.hoursAmber`),
  red "Verify booking" at 20 or fewer (`settings.hoursRed`), red "Overdue" once passed.
  Status `due` = the red verify-booking level (ranks just below overdue). Red must stay below amber.
- Aircraft availability label (`acUse`, Tom's rule): for flying aircraft (Available or
  Restricted), from the hour-based item due soonest: under 30 hrs left "Use caution" (orange,
  `cautionHrs`), under 15 "Use sparingly" (red, `sparingHrs`), past due "Maintenance overdue".
  Restricted aircraft show "Restricted · use caution" etc. Off-line aircraft unchanged.
- IOR fuel tank (Tom's figures): max safe fill 5,000 L (`settings.tankCapacity`), reorder level
  1,500 L (`settings.fuelThreshold`), standard order 3,500 L (`settings.orderTemplate.litres`).
  "Refill" means the delivery is in the tank: it logs a new reading of latest + 3,500 L and marks
  the open order delivered (with undo). 5,000 L is a hard maximum: readings above it can't be
  saved, a refill that won't fit is blocked (it offers to log the actual level instead), and the
  gauge and graph scale stop at 5,000 L.
- The header clock (top right, every page) shows Brisbane time with seconds and the date, with
  UTC beside it (24-hour); on phones local time sits over UTC. No separate clock card on the overview.
- YBSU METAR and TAF widget near the top. Always labelled as not an official briefing (check
  NAIPS). Decode only what the report says; never invent or forecast weather. YCDR has no
  METAR/TAF, so YBSU is the source.
- YCDR runway wind diagram (`windDiagram()`): runways 05/23 and 12/30, both 735 m, drawn to scale
  north-up from settings `rwy05Mag`/`rwy12Mag` (magnetic, default 050/120) plus `magVar`
  (default 11° E), since METAR wind is true. Shows head/crosswind per runway and highlights the
  runway end with most headwind. Labelled as YBSU wind. No crosswind limits unless Tom gives them.
- Calendar deadlines (`dueSoonDays`) and hour-based warnings are reported separately. Low fuel is
  "Low stock", never "Overdue". Ordered fuel is not added to stock until a new reading is logged.
- Charts show hours remaining, not percentages, unless interval and start reading are known. The
  fuel chart only plots logged readings.
- Forecasts (Tom asked for them; always labelled "guide only", never a requirement): `learnRate`
  learns a recency-weighted rate from logged values (skips refills/corrections).
  `fuelForecast` predicts when the tank reaches the order level (`settings.fuelOrderAt`, 1,000 L)
  and the level when an open order arrives. `fuelBurn` shows average daily fuel burn (learned rate, plus 7-day,
  30-day and all-readings averages from falling readings only) and days of fuel left. `maintForecast` uses each aircraft's `hoursLog`
  (one entry per day, written by `logHours` from Update hours and the aircraft form) to estimate
  when the next hour-based item is due and when to book it (when it reaches the amber level);
  items already booked or in progress show "Booked". Shown in the fuel card, fuel tile,
  booking guide (under the hours chart), chart rows, aircraft page and daily brief.
- Defects: severity is required (`DEF_SEV`: grounding, urgent, semi-urgent, nil effect). A
  grounding defect offers to mark the aircraft Unserviceable (Tom confirms) and goes to the top
  of Priority actions. Photos (`t: 'photos'` field): resized on the device, stored in D1 table
  `files` via `/api/files` (session required), shown as thumbnails and a tap-to-enlarge viewer.
- Daily brief (`openBrief`, overview button): aircraft, fuel, weather, action needed, next 7 days;
  print, copy or share. Built only from dashboard data. The tank gauge and graph share the
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
   `maintenance`, `defects`, `fuelReadings`, `fuelOrders`, `fuelIssues`, `instructors`, `tasks`, `documents`,
   plus `settings` (userName, theme, dueSoonDays, hoursWarn, fuelThreshold, tankCapacity,
   orderTemplate) and `meta`.
4. **Rules**: all overdue, due soon and missing-info logic (`dateStatus`, `maintStatus`,
   `orderStatus`, `checkState`, `attentionItems`, `upcoming`, `waitingItems`, `waitingGroups`,
   `hourItemFor`). Change status logic here only. `attentionItems()` is the single source for the
   overview cards, the Priority actions list and the tab badges, so counts always agree. Each item
   has `sev` (overdue, alert, low, soon, missing, info), `src`, `basis` ('date' or 'hours') and
   `area` (tab).
   Instructor profiles: `grade` (junior, senior, supervising, dcfi, cfi), `raausNo`, `lastCheck`
   (last S&P), `lastRenewal` (renewal or SI flight review), `renewalExpiry`, `checks` history (logged with `logCheck`, shown in
   `openInstructor`). Old free-text `role` values are mapped to a grade in `normalise()`.
5. **Schemas**: field lists in `SCHEMAS` generate every add/edit form via `openEditor(kind, id)`.
   To add a field, add it to the schema; the form, saving and validation follow.
6. **Views**: overview = summary cards, `maintChart()` (HTML bars, one hours scale),
   `fuelSummary()` (SVG line drawn at real width by `drawCharts()`, tap or arrow keys to read
   values), Priority actions (top 5), instructor rows, aircraft cards, Waiting on, Coming up.
   `renderOverview`, `renderAircraft`, `renderFuel`, `renderInstructors`,
   `renderTasks`, `renderDocs`. Hash routing (`#overview`, `#aircraft`, `#fuel`, `#instructors`, `#tasks`, `#docs`).
   Click handlers use `data-act` (the `ACT` map) or `data-reg` (functions registered per render).

Other conventions: every record gets `id`, `createdAt`, `updatedAt`, `updatedBy`, and `archived`
where archivable. Changes go through `commit()` (save and re-render). Use `withUndo()` for
complete, archive and delete. Escape all user text with `esc()`. Fuel order template defaults to
3,500 L Premium Unleaded 98 from IOR. Export/import of JSON backups is in Data & settings.

## Sign-in, sharing and identity

- Sign-in is required every time the dashboard opens (nothing remembered). No accounts: choose a
  name (Tom, Damien, Anne-Maree; `USERS` in the page and `NAMES` in the Worker, keep both in
  step) and enter the team PIN. Only the Worker knows the PIN: Cloudflare secret `GOFLY_PIN`.
  If it isn't set, nobody can sign in. Local testing: put `GOFLY_PIN=...` in `.dev.vars`
  (git-ignored).
- `POST /api/login` returns a random 12-hour session token (D1 table `sessions`); the page keeps
  it in memory only and sends `Authorization: Bearer <token>` to `/api/sync`, which stores the
  session's name as `updated_by`. `POST /api/logout` ends it. A 401 from sync sends the person
  back to the sign-in screen (unsent changes stay queued).
- Wrong PINs are logged in D1 (`login_fails`): 8 from one IP in 15 minutes, or 40 overall in an
  hour, pauses sign-in. `/api/wx` only serves YBSU.
- The signed-in name (`Who`) is the greeting name and is stamped on every change (`updatedBy`).
  The header button shows who is signed in and switches person or locks (`lockApp`).
  Nothing renders and nothing syncs until someone signs in.
- Optional: if Access is ever turned back on, set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` and the
  Worker also requires a valid Access token.

## Look and feel

GoFly-branded tiles and widgets. Logos and app icons are in `public/brand/` (made from Tom's
supplied logos; `gofly-logo-dark-bg.png` for black backgrounds, `gofly-logo-light-bg.png` for
light). Black header and an overview welcome band with an overall status (Action needed / Watch /
All clear), summary tiles tinted red or orange when they need attention, and widgets with icon
headings (`ICO(name)`, icons in `ICONS`). Inter for text; Barlow Condensed bold italic uppercase
for headings and aircraft idents, echoing the logo. Status shown by colour plus icon plus words
(red action/overdue, orange watch/due soon/low stock, green OK, dashed grey not entered). The
GoFly website is for information only; don't copy its theme. Touch targets about 44px.
Data & settings is grouped (Maintenance, Instructor checks, IOR fuel tank, Documents and expiries,
YCDR runways and wind, This device); add new settings to the right group in `openSettings`.

## Before pushing

- Keep everything in the one HTML file unless there's a clear reason to split it.
- Check the page still loads without console errors and fits 390px, 768px and 1440px widths.
- Write a plain-English commit message that says what changed for Tom.
