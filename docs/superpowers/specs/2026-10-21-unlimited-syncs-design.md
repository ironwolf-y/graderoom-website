# Unlimited Syncs — Design

**Date:** 2026-10-21
**Fork:** `ironwolf-y/graderoom-website` (fork of `graderoom/graderoom-website`, AGPL-3.0)
**Branch:** `feat/unlimited-syncs`

## Goal

Remove the donation-tier sync cooldown. Today a sync is gated on a tier minimum
(4h free / 2h donor / 1h plus / 15min premium). After this change every tier syncs on
the same short floor, so the cooldown no longer functions as a paywall.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | The floor is **60 seconds for every tier** | "Unlimited" in practice, but a stuck client or a runaway script cannot hammer PowerSchool with logins |
| 2 | The donation UI shows **"Unlimited"** in all four tier columns | The table would otherwise advertise a cooldown that no longer exists |
| 3 | The auto-sync cadence defaults to **15 minutes** (was 4 hours) | The cadence is a separate knob from the cooldown; 15 minutes is the fastest option the selector already offers |
| 4 | The tier constants are **removed**, not zeroed | Zeroing them would drag `defaultSyncPeriod` to `0` with it (`exports.defaultSyncPeriod = freeSyncPeriod`), and `0` is not in `syncPeriodOptions`, so `dbClient.js:2868` would reject every write and auto-sync would fire on every page load |

## Background: how the cooldown works

Everything funnels through one function. `server/dbHelpers.js` holds the tier constants
(lines 39-42) and `minSyncPeriod(donoData)` (line 791), which returns the tier minimum.
`nextSyncAllowed()` (line 813) and `nextSyncWhen()` (line 817) call it, and **all four
server-side gates** call those:

| Site | Path |
|---|---|
| `server/dbClient.js:3340` | `_updateGradesFromUser` — Bellarmine browser-extension grade push |
| `server/dbClient.js:3514` | `_canIUpdate` — the pre-flight check before a sync |
| `server/dbClient.js:3531` | `_updateGrades` — server-side Python scraper (BISV / NDSJ) |
| `server/passport.js:83` | login handler — auto-sync on login for Bellarmine |

The frontend is driven by two values injected into the page by
`server/routes.js:66-68` and read in `views/user/authorized_index.ejs:760-761`:

- `syncMinInterval` — the tier floor. `public/js/sync_control.js:182` `nextAllowedAt()`
  adds it to the last sync timestamp to get the manual-sync deadline, and
  `syncReady()` decides whether the chip is clickable.
- `syncInterval` — the auto-sync cadence, `max(tier floor, user preference)`.

Because both the server gate and the chip read the same floor, **changing the floor in
one place moves both**. No gate is deleted, so the `sync-limit` reporting path stays
intact and the 60-second floor is shown to the user exactly the way the old four-hour
one was.

### What this deliberately does not change

- **HTTP rate limits** (`server/middleware.js`, 30/40/60/100 req/min). These are applied
  with `app.use(rateLimit)` in `server/graderoom.js:102` to HTTP routes only — Socket.io
  has no rate limiter — so they gate page loads, not syncs.
- **The scraper queue** (`server/data_structures/queue/`). It is a strictly serial FIFO
  with a priority path for PLUS, with no timers at all. It is a queue, not a cooldown.
- **Theme, background and custom-colour gating.** Those remain donation features.
- **History sync paths** (`_updateGradeHistoryFromUser`, `_updateGradeHistory`) were
  never gated by the cooldown.

## Design

### 1. `server/dbHelpers.js` — one floor instead of four tiers

Replace the four tier constants with a single floor, and keep `minSyncPeriod`'s
signature so no call site has to change:

```js
// Every tier syncs on the same floor now. The donation tier no longer buys a shorter
// wait, so the constants that used to separate them are gone. The floor is short
// enough to feel unlimited and long enough that a stuck client cannot hammer
// PowerSchool with logins.
const syncCooldown = 60 * 1000; // 1 minute
```

```js
exports.minSyncPeriod = function (donoData) {
    // The tier argument is kept so the call sites do not change, but it no longer
    // selects anything: every plan waits the same minute.
    return syncCooldown;
};
```

`effectiveSyncPeriod` (line 805) is unchanged — it is `max(floor, user preference)` and
is used for display only, never by the server gate.

The write-path guard at `server/dbClient.js:2875` (`value < minSyncPeriod(donoData)`)
becomes a no-op, because the smallest entry in `syncPeriodOptions` is 15 minutes and
the floor is 60 seconds. It is left in place: it still rejects a value that is not a
member of `syncPeriodOptions`, which is the check that matters.

Two new constants, both required to be members of `syncPeriodOptions` because
`server/dbClient.js:2868` rejects any value outside that list:

```js
const defaultSyncPeriod = 15 * 60 * 1000; // 15 minutes
const previousDefaultSyncPeriod = 4 * 60 * 60 * 1000; // the old 4 hour default
```

`exports.defaultSyncPeriod` changes from `freeSyncPeriod` to `defaultSyncPeriod`, and the
new-user template at line 303 changes from `syncPeriod: freeSyncPeriod` to
`syncPeriod: defaultSyncPeriod`.

`exports.previousDefaultSyncPeriod` is exported so the migration can name the old value
instead of hard-coding `4 * 60 * 60 * 1000` in `dbClient.js`.

### 2. `server/dbClient.js` — migration to user version 44

`exports.dbUserVersion` (`server/dbHelpers.js:28`) goes from 43 to 44, and a
`_version44` / `__version44` pair is added following the pattern of the existing
migrations. It moves `syncPeriod` to the new default **only for users whose stored
value is the old default**, so a cadence somebody picked on purpose is left alone:

```js
const __version44 = async (db, user) => {
    if (user.version !== 43) {
        return;
    }
    let update = {version: 44};
    // Only the old default moves. A cadence the user picked themselves stays.
    if (user.syncPeriod === previousDefaultSyncPeriod) {
        update.syncPeriod = defaultSyncPeriod;
    }
    await _users(db, user.username).updateOne({username: user.username}, {$set: update});
};
```

`_version44` is appended to `versionUpdaters` (`server/dbClient.js:1869`). The guard at
line 1878 throws if `versionUpdaters.length !== dbUserVersion`, so both must move
together.

Users who are still on version 42 because `_version43` was skipped for a missing
`DISCORD_TOKEN` stay pending until a boot with the token set, which is the existing
behaviour for that migration and is left as-is.

### 3. `public/js/sync_control.js` — make the 60 seconds legible

Two changes, both about how the floor is presented rather than what it is.

**`countdown()` (line 201)** rounds a sub-minute remainder up to "1m", which would make
a one-minute floor read as "1m" for its whole duration. Add a seconds branch:

```js
if (delta < 60000) {
    return Math.ceil(delta / 1000) + 's';
}
```

**`scheduleSyncTick()` (line 238)** repaints on minute boundaries via
`(deadline - Date.now()) % 60000`, so a 60-second deadline would sit stale until it
expired. Tick every second while the deadline is under two minutes:

```js
let remaining = deadline ? deadline - Date.now() : 0;
let delay = remaining <= 0 ? 60000
    : remaining < 120000 ? Math.max(1000, remaining % 1000)
    : remaining % 60000 || 60000;
```

`nextSyncText()` (line 211) needs no change — it already produces
`"Available in 45s"`, and the `waiting` popup at line 36 already reads
"You synced very recently. You can sync again in 45s."

### 4. `public/js/authorized_index.js` — the non-Bellarmine message

`getLimitMessage()` (line 543) formats the wait in hours and minutes. It is used for
BISV and NDSJ, where the sync card shows "You need to wait 1m before syncing again."
Add the same seconds branch so the message matches the chip.

### 5. `views/partials/user/settings_card.ejs` — the donation copy

Three places advertise a cooldown that no longer exists:

- **Line 76-82**, the "Sync Cooldown" row of the donation feature table: all four cells
  become "Unlimited".
- **Lines 741-801**, the four donation progress-bar tooltips: each tier's
  sync-cadence line becomes "Unlimited manual syncs", and the `<span class="strikethrough">`
  wrappers that used to show the upgrade pitch are dropped, since there is no longer a
  faster tier to upgrade to.
- **Lines 1032-1036**, the hint under the auto-sync selector: "Your plan allows a sync
  as often as every X." becomes "Your plan allows unlimited manual syncs."

### 6. `server/dbTests.js` — the sync period test

`testSyncPeriod` (line 48) currently asserts that a 15-minute preference is floored to
the tier minimum. With a 60-second floor the preference wins, so that assertion is
rewritten, and the tier-independence of the floor is pinned:

```js
const {effectiveSyncPeriod, minSyncPeriod, nextSyncWhen, nextSyncAllowed, defaultSyncPeriod} = require("./dbHelpers");
const free = [];
const premium = [{receivedValue: 5}];

customAssert(effectiveSyncPeriod(free, defaultSyncPeriod), defaultSyncPeriod, "Sync period default");
customAssert(effectiveSyncPeriod(free, 15 * 60 * 1000), 15 * 60 * 1000, "Sync period honors a shorter choice");
customAssert(effectiveSyncPeriod(free, 24 * 60 * 60 * 1000), 24 * 60 * 60 * 1000, "Sync period honors longer choice");
customAssert(effectiveSyncPeriod(free, undefined), minSyncPeriod(free), "Sync period without a setting");
customAssert(nextSyncWhen(0, free), minSyncPeriod(free), "Server allowance ignores syncPeriod");
customAssert(minSyncPeriod(free), 60 * 1000, "The sync floor is a minute");
customAssert(minSyncPeriod(premium), minSyncPeriod(free), "Every tier shares one sync floor");
customAssert(nextSyncAllowed(Date.now(), free), false, "A sync right after the last one is refused");
customAssert(nextSyncAllowed(Date.now() - 30 * 1000, free), false, "A sync inside the floor is refused");
customAssert(nextSyncAllowed(Date.now() - 90 * 1000, free), true, "A sync past the floor is allowed");
```

The floor is defined in `dbHelpers.js` as `60 * 1000`; the test repeats the literal
because a test that reads the constant it is checking proves nothing.

### 7. Docs

- **`CLAUDE.md`**, the "User Tiers & Rate Limiting" section: the "Minimum sync
  intervals (4h/2h/1h/15min)" line becomes a single shared floor, and the `syncPeriod`
  description is updated to say the default is now 15 minutes.
- **`README.md`**: a short note at the top saying this is a fork with unlimited syncs
  and pointing at the design doc.

## Data flow

**Manual sync, Bellarmine (extension).** Click on the chip → `initSync()`
(`sync_control.js:298`) → `can-i-update` socket event → `_canIUpdate`
(`dbClient.js:3504`) → `nextSyncAllowed(lastSync, donoData)` → `minSyncPeriod()` returns
`60000`. Inside the floor the server answers `sync-limit` with the deadline; the chip
pins itself to it via `syncBlocked(timestamp)` (`authorized_index.js:413`) and shows
"Available in 45s". Past the floor the server answers `you-can-update`, the extension
scrapes, and the grades arrive over `start-update-from-user`.

**Auto-sync.** `maybeAutoSync()` (`sync_control.js:247`) fires on `info-initialstatus`
— that is, on page load — and only syncs when `autoSyncDue()` holds, i.e. when
`syncInterval` has elapsed since the last sync. There is no server-side scheduler and
no repeating client timer, so a 15-minute cadence means "sync when you open the page,
if 15 minutes have passed", not 96 logins a day.

**Non-Bellarmine (server-side scraper).** The sync card posts the school password →
`start-update` socket event → `_updateGrades` (`dbClient.js:3521`) → the same
`nextSyncAllowed` check → `scraper.loginAndScrapeGrades` → the serial scraper queue →
the Python scraper. The queue, not a timer, is what a user waits in here.

## Error handling

The 60-second floor produces the same failure mode the four-hour floor did, one
thousand times smaller. The server sets `SyncStatus.LIMIT`, emits `sync-limit` with the
deadline, and returns "You need to wait before syncing again."
(`dbClient.js:4487`). The socket handler at `server/socket.js:98` suppresses that
message so the client is not shown a generic sync failure, and the client shows the
countdown instead. None of this changes; it simply runs at a different interval.

## Verification

MongoDB is not available on this machine, so `npm test` cannot run. The work is
verified in three layers:

1. **Static check** — `node --check` on every changed `.js` file.
2. **Logic check** — a standalone Node script that loads `server/dbHelpers.js` and
   asserts the floor, the tier-independence, the floor arithmetic in `nextSyncWhen` /
   `nextSyncAllowed`, and the `effectiveSyncPeriod` results that `dbTests.js` asserts.
   This is the same arithmetic `testSyncPeriod` covers, run without a database.
3. **Render check** — a script that renders the EJS templates that changed with a stub
   user and greps the output for the stale strings ("Sync once every", "Sync Cooldown",
   "allows a sync as often as"), confirming none survive.

`server/dbTests.js` is updated in the same commit so the suite passes wherever
MongoDB is available.

## Out of scope

- Removing the donation system, tiers or themes.
- Changing the HTTP rate limits.
- Changing the scraper queue or the "Bypass the sync queue" PLUS perk.
- Changing the Bellarmine browser extension, which lives in a different repository.
