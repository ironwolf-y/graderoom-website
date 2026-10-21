# Unlimited Syncs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the donation-tier sync cooldown so every tier syncs on the same 60-second floor, and move the auto-sync cadence default from 4 hours to 15 minutes.

**Architecture:** The cooldown has exactly one source of truth — `minSyncPeriod()` in `server/dbHelpers.js` — and all four server gates plus the frontend chip read it. Changing that one function moves both sides at once, so no gate is deleted and the existing `sync-limit` reporting path keeps working. A user-schema migration to version 44 moves the stored `syncPeriod` preference for users who never changed it away from the old 4-hour default.

**Tech Stack:** Node.js (CommonJS), Express, EJS, MongoDB (raw driver), Socket.io, vanilla JS front end.

**Spec:** `docs/superpowers/specs/2026-10-21-unlimited-syncs-design.md`

## Global Constraints

- The sync floor is exactly `60 * 1000` milliseconds for **every** tier. There is no tier-dependent value anywhere.
- The auto-sync cadence default is exactly `15 * 60 * 1000` milliseconds (15 minutes).
- The old auto-sync default, `4 * 60 * 60 * 1000`, must survive as a named constant so the migration can match on it.
- `defaultSyncPeriod` **must** be a member of `syncPeriodOptions` — `server/dbClient.js:2868` rejects any value that is not in that list, and the list's smallest entry is 15 minutes.
- `server/dbHelpers.js` exports `dbUserVersion` and `server/dbClient.js` holds a `versionUpdaters` array with a length guard (`server/dbClient.js:1878`) that throws if the array length and `dbUserVersion` disagree. **Every schema bump must move both.**
- The project's only test runner is `node` with the built-in `assert` module, driven by `server/dbTests.js`. There is no framework, no `describe`/`it`, and no test file per module.
- MongoDB is **not installed** in this environment (no `MongoDB` service, no Docker, `127.0.0.1:27017` refuses connections). The real suite still runs against an in-memory MongoDB — see Task 7 Step 6 for the exact command. Verification during development uses `node scripts/verify-sync.js` (a standalone script this plan creates) and `node --check`.
- `node_modules` must be installed before anything that `require`s a package: run `npm ci` once, first.
- **This environment is Windows PowerShell 5.1**: there is no `grep` binary and `&&` does not chain commands. Every verification command in this plan is written as `node -e "..."` so it works the same on Windows, macOS and Linux. `;` separates commands inside one `node -e` script; separate shell steps are separate code blocks.
- On Windows use `python`, not `python3`.
- License: AGPL-3.0. The fork keeps the upstream `LICENSE` unchanged.

## Review Focus

Each line is a failure mode the spec implies but no upstream test covers. The task that owns the code carries the test that pins it.

1. **A user whose stored `syncPeriod` is the old 4-hour default** — they should be moved to 15 minutes by the version-44 migration, because the default changed under them. (Pinned in Task 2.)
2. **A user who deliberately picked a cadence other than the old default** (30 minutes, 2 hours, 24 hours…) — their choice must survive the migration untouched. (Pinned in Task 2.)
3. **A user who is still on schema version 42** because `_version43` was skipped for a missing `DISCORD_TOKEN` — the version-44 migration must not half-apply; it must leave the user pending rather than bumping the version while skipping the `syncPeriod` change. (Pinned in Task 2.)
4. **A sync attempted 30 seconds after the last one** — must be refused with the deadline, the same way the old four-hour floor refused one. (Pinned in Task 1.)
5. **A sync attempted 90 seconds after the last one** — must be allowed, proving the floor is a floor and not a wall. (Pinned in Task 1.)

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `server/dbHelpers.js` | modify | Owns the sync floor, the auto-sync default, and the user schema version |
| `server/dbClient.js` | modify | Owns the version-44 migration and the user-schema updater list |
| `scripts/verify-sync.js` | create | Standalone checks for the fork's sync behaviour, runnable without MongoDB or a browser |
| `public/js/sync_control.js` | modify | The navbar chip: deadline maths and the repaint timer |
| `public/js/authorized_index.js` | modify | The non-Bellarmine "you need to wait" message |
| `views/partials/user/settings_card.ejs` | modify | Donation-table and auto-sync-selector copy |
| `server/dbTests.js` | modify | The `testSyncPeriod` suite |
| `CLAUDE.md` | modify | Documents the tier model for future agents |
| `README.md` | modify | Fork notice |

---

## Task 1: The shared sync floor

**Files:**
- Create: `scripts/verify-sync.js`
- Modify: `server/dbHelpers.js:39-42` (constants), `server/dbHelpers.js:303` (new-user template), `server/dbHelpers.js:791-803` (`minSyncPeriod`), `server/dbHelpers.js:811` (`defaultSyncPeriod`)
- Test: `server/dbTests.js:48-55` (`testSyncPeriod`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `server/dbHelpers.js` → `exports.minSyncPeriod(donoData: Array): number` — returns `60000` for every input. The parameter is retained so no call site changes.
  - `server/dbHelpers.js` → `exports.defaultSyncPeriod: number` — `900000`.
  - `server/dbHelpers.js` → `exports.previousDefaultSyncPeriod: number` — `14400000` (4 hours), consumed by Task 2.
  - `server/dbHelpers.js` → `exports.nextSyncWhen(lastSyncTimestamp: number, donoData: Array): number` — unchanged signature, now returns `lastSyncTimestamp + 60000`.
  - `server/dbHelpers.js` → `exports.nextSyncAllowed(lastSyncTimestamp: number, donoData: Array): boolean` — unchanged signature.
  - `scripts/verify-sync.js` → `node scripts/verify-sync.js` — exits 0 when every check passes, 1 otherwise. Later tasks append their own checks to this file.

- [ ] **Step 1: Install the dependencies**

```bash
npm ci
```

Expected: `added 146 packages`. Required before any `require` of a package.

- [ ] **Step 2: Create the standalone verification script**

Create `scripts/verify-sync.js`:

```js
// Standalone checks for this fork's sync behaviour. Runs without MongoDB and without
// a browser:   node scripts/verify-sync.js
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (label, actual, expected) => {
    if (actual !== expected) {
        failures++;
        console.error(`FAIL  ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
        return;
    }
    console.log(`ok    ${label}`);
};

// ---- server side ------------------------------------------------------------
const helpers = require('../server/dbHelpers');
const free = [];
const premium = [{receivedValue: 5}];

check('the floor is a minute', helpers.minSyncPeriod(free), 60 * 1000);
check('every tier shares the floor', helpers.minSyncPeriod(premium), helpers.minSyncPeriod(free));
check('nextSyncWhen adds the floor', helpers.nextSyncWhen(0, free), 60 * 1000);
check('a sync right after the last one is refused', helpers.nextSyncAllowed(Date.now(), free), false);
check('a sync inside the floor is refused', helpers.nextSyncAllowed(Date.now() - 30 * 1000, free), false);
check('a sync past the floor is allowed', helpers.nextSyncAllowed(Date.now() - 90 * 1000, free), true);
check('the default cadence is 15 minutes', helpers.defaultSyncPeriod, 15 * 60 * 1000);
check('the default cadence is a valid option', helpers.syncPeriodOptions.includes(helpers.defaultSyncPeriod), true);
check('the previous default is kept for the migration', helpers.previousDefaultSyncPeriod, 4 * 60 * 60 * 1000);
check('a shorter preference wins', helpers.effectiveSyncPeriod(free, 15 * 60 * 1000), 15 * 60 * 1000);
check('a longer preference wins', helpers.effectiveSyncPeriod(free, 24 * 60 * 60 * 1000), 24 * 60 * 60 * 1000);
check('no preference falls back to the floor', helpers.effectiveSyncPeriod(free, undefined), 60 * 1000);

process.exit(failures ? 1 : 0);
```

- [ ] **Step 3: Run the script to verify it fails**

```bash
node scripts/verify-sync.js
```

Expected: FAIL on the first check — `FAIL the floor is a minute: got 14400000, want 60000` (the current free floor is 4 hours) — and exit code 1.

- [ ] **Step 4: Replace the tier constants with one floor**

In `server/dbHelpers.js`, replace lines 39-42:

```js
const freeSyncPeriod = 4 * 60 * 60 * 1000; // 4 hours
const donorSyncPeriod = 2 * 60 * 60 * 1000; // 2 hours
const plusSyncPeriod = 60 * 60 * 1000; // 1 hour
const premiumSyncPeriod = 15 * 60 * 1000; // 15 minutes
```

with:

```js
// Every tier syncs on the same floor now. The donation tier no longer buys a shorter
// wait, so the constants that used to separate them are gone. The floor is short enough
// to feel unlimited and long enough that a stuck client cannot hammer PowerSchool.
const syncCooldown = 60 * 1000; // 1 minute

// The auto-sync cadence is a separate preference from the floor, and 15 minutes is the
// smallest entry in syncPeriodOptions. The old 4 hour default is kept so the schema
// migration can tell a default apart from a choice.
const defaultSyncPeriod = 15 * 60 * 1000; // 15 minutes
const previousDefaultSyncPeriod = 4 * 60 * 60 * 1000; // 4 hours
```

- [ ] **Step 5: Make `minSyncPeriod` tier-independent**

In `server/dbHelpers.js`, replace the body of `minSyncPeriod` (currently lines 791-803):

```js
exports.minSyncPeriod = function (donoData) {
    let {donor, plus, premium} = exports.donoAttributes(donoData);
    if (premium) {
        return premiumSyncPeriod;
    }
    if (plus) {
        return plusSyncPeriod;
    }
    if (donor) {
        return donorSyncPeriod;
    }
    return freeSyncPeriod;
};
```

with:

```js
exports.minSyncPeriod = function (donoData) {
    // The tier argument is kept so the call sites do not change, but it no longer
    // selects anything: every plan waits the same minute.
    return syncCooldown;
};
```

`effectiveSyncPeriod` (line 805) and `nextSyncAllowed` / `nextSyncWhen` (lines 813-819) are **not** modified — they delegate to `minSyncPeriod` and pick up the new floor automatically.

- [ ] **Step 6: Point the default at 15 minutes**

In `server/dbHelpers.js`, replace line 811:

```js
exports.defaultSyncPeriod = freeSyncPeriod;
```

with:

```js
exports.defaultSyncPeriod = defaultSyncPeriod;
exports.previousDefaultSyncPeriod = previousDefaultSyncPeriod;
```

In the same file, replace the new-user template at line 303:

```js
syncPeriod: freeSyncPeriod,
```

with:

```js
syncPeriod: defaultSyncPeriod,
```

- [ ] **Step 7: Verify the script passes**

```bash
node scripts/verify-sync.js
```

Expected: twelve `ok` lines and exit code 0.

- [ ] **Step 8: Confirm the removed constants are gone**

```bash
node -e "const fs=require('fs'),path=require('path');const hits=[];const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(['.js','.ejs'].includes(path.extname(p))){fs.readFileSync(p,'utf8').split('\n').forEach((l,i)=>{if(/freeSyncPeriod|donorSyncPeriod|plusSyncPeriod|premiumSyncPeriod/.test(l))hits.push(p+':'+(i+1))})}}};['server','views','public','scripts'].forEach(walk);if(hits.length){console.error('still referenced: '+hits.join(', '));process.exit(1)}console.log('no stale sync-period constants')"
```

Expected: `no stale sync-period constants` and exit code 0.

- [ ] **Step 9: Update the real test suite**

Replace the `testSyncPeriod` block in `server/dbTests.js` (currently lines 48-55) with:

```js
    }, testSyncPeriod: async () => {
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
    },
```

`nextSyncAllowed(Date.now(), free)` is expected **false**: the timestamp is "the last sync happened now", so the floor has not elapsed.

- [ ] **Step 10: Syntax-check**

```bash
node --check server/dbHelpers.js
node --check server/dbTests.js
node --check scripts/verify-sync.js
```

Expected: exit code 0 for all three, no output.

- [ ] **Step 11: Commit**

```bash
git add server/dbHelpers.js server/dbTests.js scripts/verify-sync.js
git commit -m "feat: one shared sync floor for every tier

The cooldown was a donation perk: 4h free, 2h donor, 1h plus, 15min premium.
Every tier now waits the same minute, so the tier no longer buys a shorter
sync. The auto-sync cadence default moves from 4 hours to 15 minutes, which
is the smallest entry in syncPeriodOptions.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Migration to user schema version 44

**Files:**
- Modify: `server/dbHelpers.js:28` (`dbUserVersion`)
- Modify: `server/dbClient.js:61-62` (import), `server/dbClient.js` (new migration, after `__version43`), `server/dbClient.js:1869-1876` (`versionUpdaters`)
- Test: `scripts/verify-sync.js` (append the migration-decision checks)

**Interfaces:**
- Consumes: `exports.previousDefaultSyncPeriod` and `exports.defaultSyncPeriod` from `server/dbHelpers.js` (Task 1).
- Produces: `exports.dbUserVersion = 44`; a `_version44` / `__version44` pair in `server/dbClient.js`; `_version44` appended to `versionUpdaters`.

- [ ] **Step 1: Bump the schema version**

In `server/dbHelpers.js`, change line 28:

```js
exports.dbUserVersion = 43;
```

to:

```js
exports.dbUserVersion = 44;
```

- [ ] **Step 2: Import the new constant**

In `server/dbClient.js`, line 61 ends with `defaultSyncPeriod,` and line 62 begins `minSyncPeriod, appearanceKeys`. Change line 61 so it ends with `defaultSyncPeriod, previousDefaultSyncPeriod,` — keeping the same one-line-per-group style the block already uses.

The result reads:

```js
    checkValidTerm, checkValidSemester, processClasses, nextSyncWhen, syncPeriodOptions, defaultSyncPeriod, previousDefaultSyncPeriod,
    minSyncPeriod, appearanceKeys
```

- [ ] **Step 3: Write the migration**

In `server/dbClient.js`, add this pair immediately after `__version43` (which ends at line 1865) and before the `versionUpdaters` array:

```js
const _version44 = async (db, username) => {
    let res = await getUser(username, {version: 1, syncPeriod: 1});
    if (!res.success) {
        return res;
    }

    let user = res.data.value;
    await safe(__version44, user);

    return {success: true, data: {log: `Updated ${username} to version 44`}};
}

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
}
```

The `user.version !== 43` guard is deliberate: a user left on version 42 (because `_version43` was skipped for a missing `DISCORD_TOKEN`) must stay pending rather than have its version bumped while its `syncPeriod` is left behind. The next boot with the token set runs `_version43` and then `_version44`.

- [ ] **Step 4: Register the migration**

In `server/dbClient.js`, append `_version44` to the `versionUpdaters` array (lines 1869-1876). The array's last entry is currently `_version43`; the new last entry is `_version44`.

The guard at line 1878 throws `dbUserVersion is 44 but there are 43 version updaters` if these two disagree, so this step and Step 1 must land together.

- [ ] **Step 5: Verify the guard is satisfied**

The length check runs when `server/dbClient.js` is required, so requiring the module is the test:

```bash
node -e "require('./server/dbClient');console.log('dbClient loaded, versionUpdaters length matches dbUserVersion')"
```

Expected: `dbClient loaded, versionUpdaters length matches dbUserVersion` and exit code 0. A mismatch throws `dbUserVersion is 44 but there are 43 version updaters` instead.

- [ ] **Step 6: Append the migration-decision checks**

In `scripts/verify-sync.js`, insert these checks above the `process.exit` line:

```js
// ---- the version 44 migration ------------------------------------------------
// The decision the migration makes on a user document, exercised without a database.
const decideVersion44 = (user) => {
    if (user.version !== 43) {
        return null;
    }
    let update = {version: 44};
    if (user.syncPeriod === helpers.previousDefaultSyncPeriod) {
        update.syncPeriod = helpers.defaultSyncPeriod;
    }
    return update;
};

check('the old default moves to 15 minutes',
    decideVersion44({version: 43, syncPeriod: helpers.previousDefaultSyncPeriod}),
    {version: 44, syncPeriod: helpers.defaultSyncPeriod});
check('a deliberate 30 minute choice survives',
    decideVersion44({version: 43, syncPeriod: 30 * 60 * 1000}),
    {version: 44});
check('a deliberate 24 hour choice survives',
    decideVersion44({version: 43, syncPeriod: 24 * 60 * 60 * 1000}),
    {version: 44});
check('a user pending on version 42 stays pending',
    decideVersion44({version: 42, syncPeriod: helpers.previousDefaultSyncPeriod}),
    null);
```

The `check` helper compares with `!==`, so it cannot compare two objects by value. Change the helper at the top of the file to compare with `JSON.stringify` instead, which handles both primitives and objects:

```js
const check = (label, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures++;
        console.error(`FAIL  ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
        return;
    }
    console.log(`ok    ${label}`);
};
```

Note that the object-literal expectations above list their keys in the order the migration builds them (`version` then `syncPeriod`), and `JSON.stringify` preserves insertion order, so the comparison is stable.

- [ ] **Step 7: Verify the script still passes**

```bash
node scripts/verify-sync.js
```

Expected: sixteen `ok` lines and exit code 0.

- [ ] **Step 8: Syntax-check**

```bash
node --check server/dbClient.js
node --check server/dbHelpers.js
node --check scripts/verify-sync.js
```

Expected: exit code 0 for all three, no output.

- [ ] **Step 9: Commit**

```bash
git add server/dbHelpers.js server/dbClient.js scripts/verify-sync.js
git commit -m "feat: migrate the auto-sync cadence to the new default

User schema version 44 moves syncPeriod from the old 4 hour default to 15
minutes, but only where the stored value still is that default, so a
cadence somebody picked on purpose is left alone.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: The chip reads the floor in seconds

**Files:**
- Modify: `public/js/sync_control.js:201-209` (`countdown`), `public/js/sync_control.js:238-245` (`scheduleSyncTick`)
- Test: `scripts/verify-sync.js` (append the chip checks)

**Interfaces:**
- Consumes: nothing from earlier tasks — the chip reads `syncMinInterval`, which the server renders from `minSyncPeriod()` (Task 1).
- Produces: `countdown(deadline: number): string|null` returns a seconds string for deadlines under a minute; `scheduleSyncTick()` repaints at least once a second while a deadline is under two minutes away.

- [ ] **Step 1: Append the failing chip checks**

In `scripts/verify-sync.js`, insert above the `process.exit` line:

```js
// ---- the navbar chip ---------------------------------------------------------
// The chip is plain browser code with no test harness, so its functions are
// lifted out of the source and run here.
const extract = (file, name, indent) => {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const pattern = new RegExp(`function ${name}\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n${' '.repeat(indent)}\\}`);
    const match = src.match(pattern);
    if (!match) {
        throw new Error(`could not find ${name} in ${file}`);
    }
    return match[1];
};

const countdown = new Function('deadline', extract('public/js/sync_control.js', 'countdown', 4));
const chipNow = Date.now();
check('a 45 second wait reads in seconds', countdown(chipNow + 45000), '45s');
check('a 5 second wait reads in seconds', countdown(chipNow + 5000), '5s');
check('a 5 minute wait still reads in minutes', countdown(chipNow + 5 * 60000), '5m');
check('a 30 minute wait still reads in minutes', countdown(chipNow + 30 * 60000), '30m');
check('a passed deadline is null', countdown(chipNow - 1000), null);
check('no deadline is null', countdown(0), null);
```

These deliberately avoid exact minute boundaries: the formatter rounds minutes up, so a value one millisecond under a boundary would read "2m" instead of "1m".

- [ ] **Step 2: Run the script to verify it fails**

```bash
node scripts/verify-sync.js
```

Expected: FAIL — `FAIL a 45 second wait reads in seconds: got "1m", want "45s"` — and exit code 1.

- [ ] **Step 3: Add the seconds branch**

In `public/js/sync_control.js`, replace `countdown` (currently lines 201-209):

```js
    function countdown(deadline) {
        if (!deadline) return null;

        let delta = deadline - Date.now();
        if (delta <= 0) return null;
        let hours = Math.floor(delta / 36e5);
        let minutes = Math.ceil((delta % 36e5) / 6e4);
        return (hours > 0 ? hours + 'h' + (minutes > 0 ? ' ' : '') : '') + (minutes > 0 ? minutes + 'm' : '');
    }
```

with:

```js
    function countdown(deadline) {
        if (!deadline) return null;

        let delta = deadline - Date.now();
        if (delta <= 0) return null;
        // The floor is a minute, so a remainder under a minute has to say so in seconds.
        // Rounding it up to minutes would read as "1m" for the whole wait.
        if (delta < 60000) {
            return Math.ceil(delta / 1000) + 's';
        }
        let hours = Math.floor(delta / 36e5);
        let minutes = Math.ceil((delta % 36e5) / 6e4);
        return (hours > 0 ? hours + 'h' + (minutes > 0 ? ' ' : '') : '') + (minutes > 0 ? minutes + 'm' : '');
    }
```

- [ ] **Step 4: Make the repaint timer keep up with the seconds**

In `public/js/sync_control.js`, replace `scheduleSyncTick` (currently lines 238-245):

```js
    function scheduleSyncTick() {
        let deadline = syncState === 'ready' ? nextAutoAt() : nextAllowedAt();
        let untilBoundary = deadline ? (deadline - Date.now()) % 60000 : 0;
        setTimeout(() => {
            syncControl();
            scheduleSyncTick();
        }, untilBoundary > 0 ? untilBoundary : 60000);
    }
```

with:

```js
    function scheduleSyncTick() {
        let deadline = syncState === 'ready' ? nextAutoAt() : nextAllowedAt();
        let remaining = deadline ? deadline - Date.now() : 0;
        // A deadline under two minutes away is the sync floor, which counts down in
        // seconds, so it needs to be repainted at least once a second. Longer
        // deadlines land on a minute boundary as before.
        let delay = remaining <= 0 ? 60000
            : remaining < 120000 ? Math.max(1000, remaining % 1000)
                : remaining % 60000 || 60000;
        setTimeout(() => {
            syncControl();
            scheduleSyncTick();
        }, delay);
    }
```

- [ ] **Step 5: Append the timer checks**

In `scripts/verify-sync.js`, insert above the `process.exit` line:

```js
const tickDelay = (remaining) => remaining <= 0 ? 60000
    : remaining < 120000 ? Math.max(1000, remaining % 1000)
    : remaining % 60000 || 60000;

check('no deadline waits a minute', tickDelay(0), 60000);
check('a passed deadline waits a minute', tickDelay(-5), 60000);
check('inside the floor it repaints every second', tickDelay(45000), 1000);
check('at the floor it repaints every second', tickDelay(60000), 1000);
check('just under two minutes it repaints every second', tickDelay(119999), 1000);
check('two minutes out it waits a minute', tickDelay(120000), 60000);
check('fifteen minutes out it waits a minute', tickDelay(900000), 60000);
```

- [ ] **Step 6: Verify the script passes**

```bash
node scripts/verify-sync.js
```

Expected: twenty-nine `ok` lines and exit code 0.

- [ ] **Step 7: Syntax-check**

```bash
node --check public/js/sync_control.js
```

Expected: exit code 0, no output.

- [ ] **Step 8: Commit**

```bash
git add public/js/sync_control.js scripts/verify-sync.js
git commit -m "feat: count the sync floor down in seconds

A one minute floor rounded up to minutes would read as 1m for the whole
wait, and the repaint timer only fired on minute boundaries, so the chip
sat on a stale number until it expired.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: The non-Bellarmine wait message

**Files:**
- Modify: `public/js/authorized_index.js:543-552` (`getLimitMessage`)
- Test: `scripts/verify-sync.js` (append the message checks)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `getLimitMessage(timestamp: number): string` — reads "You need to wait 45s before syncing again." for a sub-minute wait.

- [ ] **Step 1: Append the failing message checks**

In `scripts/verify-sync.js`, insert above the `process.exit` line:

```js
// ---- the non-Bellarmine wait message ------------------------------------------
const getLimitMessage = new Function('timestamp', extract('public/js/authorized_index.js', 'getLimitMessage', 8));
const messageNow = Date.now();
check('the wait message reads in seconds',
    getLimitMessage(messageNow + 45000),
    'You need to wait 45s before syncing again.');
check('the wait message still reads in minutes',
    getLimitMessage(messageNow + 5 * 60000),
    'You need to wait 5m before syncing again.');
```

- [ ] **Step 2: Run the script to verify it fails**

```bash
node scripts/verify-sync.js
```

Expected: FAIL — `FAIL the wait message reads in seconds: got "You need to wait 1m before syncing again.", want "You need to wait 45s before syncing again."` — and exit code 1.

- [ ] **Step 3: Add the seconds branch**

In `public/js/authorized_index.js`, replace `getLimitMessage` (currently lines 543-552):

```js
        function getLimitMessage(timestamp) {
            let date = new Date(timestamp);
            let now = new Date();

            let hours = Math.floor((date - now) / 36e5);
            let minutes = Math.ceil(((date - now) % 36e5) / 6e4);
            let timeString = (hours > 0 ? hours + "h" + (minutes > 0 ? " " : "") : "") +
                (minutes > 0 ? minutes + "m" : "");
            return `You need to wait ${timeString} before syncing again.`;
        }
```

with:

```js
        function getLimitMessage(timestamp) {
            let date = new Date(timestamp);
            let now = new Date();

            let delta = date - now;
            // The floor is a minute, so a wait under a minute says so in seconds.
            if (delta < 60000) {
                return `You need to wait ${Math.ceil(delta / 1000)}s before syncing again.`;
            }
            let hours = Math.floor(delta / 36e5);
            let minutes = Math.ceil((delta % 36e5) / 6e4);
            let timeString = (hours > 0 ? hours + "h" + (minutes > 0 ? " " : "") : "") +
                (minutes > 0 ? minutes + "m" : "");
            return `You need to wait ${timeString} before syncing again.`;
        }
```

- [ ] **Step 4: Verify the script passes**

```bash
node scripts/verify-sync.js
```

Expected: thirty-one `ok` lines and exit code 0.

- [ ] **Step 5: Syntax-check**

```bash
node --check public/js/authorized_index.js
```

Expected: exit code 0, no output.

- [ ] **Step 6: Commit**

```bash
git add public/js/authorized_index.js scripts/verify-sync.js
git commit -m "feat: say the sync wait in seconds

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: The donation copy stops advertising a cooldown

**Files:**
- Modify: `views/partials/user/settings_card.ejs:76-82` (the "Sync Cooldown" row), `views/partials/user/settings_card.ejs:741-801` (the four tier tooltips), `views/partials/user/settings_card.ejs:1032-1036` (the auto-sync hint)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no new interfaces — this task only changes rendered copy.

- [ ] **Step 1: Confirm the stale copy is present**

```bash
node -e "const fs=require('fs');const t=fs.readFileSync('views/partials/user/settings_card.ejs','utf8');const hits=['Sync Cooldown','Sync once every','allows a sync as often as'].filter(s=>t.includes(s));if(hits.length!==3){console.error('expected 3 stale strings, found '+hits.length);process.exit(1)}console.log('stale copy present: '+hits.join(', '))"
```

Expected: `stale copy present: Sync Cooldown, Sync once every, allows a sync as often as` and exit code 0.

- [ ] **Step 2: Replace the "Sync Cooldown" table row**

In `views/partials/user/settings_card.ejs`, replace lines 76-82:

```ejs
                                <tr>
                                    <th><span>Sync Cooldown</span></th>
                                    <td class="supported text">4 hr</td>
                                    <td class="supported text">2 hr</td>
                                    <td class="supported text">1 hr</td>
                                    <td class="supported text">15 min</td>
                                </tr>
```

with:

```ejs
                                <tr>
                                    <th><span>Sync Cooldown</span></th>
                                    <td class="supported text">Unlimited</td>
                                    <td class="supported text">Unlimited</td>
                                    <td class="supported text">Unlimited</td>
                                    <td class="supported text">Unlimited</td>
                                </tr>
```

- [ ] **Step 3: Replace the four tier tooltips**

In `views/partials/user/settings_card.ejs`, the free tier tooltip (line 749) currently reads:

```ejs
                                                <span>Sync once every 4 hours</span>
```

Replace it with:

```ejs
                                                <span>Unlimited manual syncs</span>
```

The donor tooltip (line 760) currently reads:

```ejs
                                                <span>Sync once every <span class="strikethrough">4</span>2 hours</span>
```

Replace it with:

```ejs
                                                <span>Unlimited manual syncs</span>
```

The plus tooltip (lines 773-774) currently reads:

```ejs
                                                <span>Sync once every <span
                                                            class="strikethrough">2 hours</span>1 hour</span>
```

Replace it with:

```ejs
                                                <span>Unlimited manual syncs</span>
```

The premium tooltip (line 793) currently reads:

```ejs
                                                <span>Sync once every <span class="strikethrough">1 hour</span>15 minutes</span>
```

Replace it with:

```ejs
                                                <span>Unlimited manual syncs</span>
```

The `<span class="strikethrough">` wrappers are dropped along with the old text: there is no faster tier left to pitch.

- [ ] **Step 4: Replace the auto-sync hint**

In `views/partials/user/settings_card.ejs`, replace lines 1032-1036:

```ejs
                            <small style="opacity: 0.5; display: block">Graderoom syncs on its own about every <span
                                        id="syncPeriodHint"></span>. Your plan allows a sync as often as every
                                <%= _syncPeriodOptions[0] < 3600000 ? (_syncPeriodOptions[0] / 60000) + " minutes"
                                    : _syncPeriodOptions[0] === 3600000 ? "hour"
                                        : (_syncPeriodOptions[0] / 3600000) + " hours" %>.</small>
```

with:

```ejs
                            <small style="opacity: 0.5; display: block">Graderoom syncs on its own about every <span
                                        id="syncPeriodHint"></span>. Your plan allows unlimited manual syncs.</small>
```

- [ ] **Step 5: Verify no stale copy remains**

```bash
node -e "const fs=require('fs');const t=fs.readFileSync('views/partials/user/settings_card.ejs','utf8');const stale=['Sync once every','allows a sync as often as'].filter(s=>t.includes(s));if(stale.length){console.error('stale: '+stale.join(', '));process.exit(1)}const unlimited=(t.match(/Unlimited/g)||[]).length;if(unlimited!==8){console.error('expected 8 Unlimited cells and tooltips, found '+unlimited);process.exit(1)}console.log('donation copy clean: 4 table cells + 4 tooltips')"
```

Expected: `donation copy clean: 4 table cells + 4 tooltips` and exit code 0. Eight is four table cells plus four tooltip lines; the auto-sync hint says "unlimited" in lower case and is not part of that count.

- [ ] **Step 6: Compile the template**

The template's locals are only known at render time, so compile it rather than rendering it — `ejs.compile` catches template syntax errors without needing any of them:

```bash
node -e "const ejs=require('ejs'),fs=require('fs');ejs.compile(fs.readFileSync('views/partials/user/settings_card.ejs','utf8'),{filename:'views/partials/user/settings_card.ejs'});console.log('settings_card compiles')"
```

Expected: `settings_card compiles` and exit code 0.

- [ ] **Step 7: Commit**

```bash
git add views/partials/user/settings_card.ejs
git commit -m "feat: stop advertising a cooldown that is gone

Every tier gets the same sync floor now, so the donation table and the tier
tooltips say Unlimited instead of quoting four hour, two hour, one hour and
fifteen minute waits.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Documentation

**Files:**
- Modify: `CLAUDE.md` ("User Tiers & Rate Limiting" section)
- Modify: `README.md` (fork notice)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no new interfaces.

- [ ] **Step 1: Update `CLAUDE.md`**

In `CLAUDE.md`, in the "User Tiers & Rate Limiting" section, the bullet reading:

```
- Minimum sync intervals (4h/2h/1h/15min), the only thing the server gates on
  (`nextSyncAllowed()` / `nextSyncWhen()` in `dbHelpers.js`).
```

becomes:

```
- Minimum sync interval: one shared floor of 60s for every tier, the only thing the
  server gates on (`nextSyncAllowed()` / `nextSyncWhen()` in `dbHelpers.js`). The
  donation tier no longer buys a shorter wait.
```

And the bullet reading:

```
- `syncPeriod` (Settings > Advanced > PowerSchool Sync Settings, default 4h) is the user's
  auto-sync preference. `effectiveSyncPeriod()` = `max(tier minimum, syncPeriod)`, rendered as
  `syncInterval`; the tier minimum is rendered as `syncMinInterval`. The chip is clickable on
  `syncMinInterval`; its sub-line reads `syncMinInterval` while waiting ("Auto in 2h" when an
  auto-sync fires at the end of it, "Available in 2h" otherwise) and `syncInterval` once
  clickable ("Auto in 4h").
```

becomes:

```
- `syncPeriod` (Settings > Advanced > PowerSchool Sync Settings, default 15m) is the user's
  auto-sync preference. `effectiveSyncPeriod()` = `max(tier minimum, syncPeriod)`, rendered as
  `syncInterval`; the tier minimum is rendered as `syncMinInterval`. The chip is clickable on
  `syncMinInterval`; its sub-line reads `syncMinInterval` while waiting ("Auto in 10m" when an
  auto-sync fires at the end of it, "Available in 45s" otherwise) and `syncInterval` once
  clickable ("Auto in 15m"). Under a minute the chip counts in seconds.
```

- [ ] **Step 2: Add the fork notice to `README.md`**

Insert directly after the `# Graderoom` heading in `README.md`:

```markdown
> **This is a fork.** The donation-tier sync cooldown has been removed: every tier syncs on
> the same one minute floor, and the auto-sync cadence defaults to 15 minutes. See
> `docs/superpowers/specs/2026-10-21-unlimited-syncs-design.md`. Everything else is upstream.
```

- [ ] **Step 3: Verify the docs**

```bash
node -e "const fs=require('fs');const c=fs.readFileSync('CLAUDE.md','utf8');const stale=['4h/2h/1h/15min','default 4h'].filter(s=>c.includes(s));if(stale.length){console.error('stale: '+stale.join(', '));process.exit(1)}if(!c.includes('one shared floor of 60s')){console.error('missing the new floor line');process.exit(1)}if(!c.includes('default 15m')){console.error('missing the new default');process.exit(1)}const r=fs.readFileSync('README.md','utf8');if(!r.includes('This is a fork')){console.error('missing the fork notice');process.exit(1)}console.log('docs updated')"
```

Expected: `docs updated` and exit code 0.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: describe the shared sync floor

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Whole-branch verification

**Files:**
- Verify: every file changed by Tasks 1-6.

**Interfaces:**
- Consumes: all of Tasks 1-6.
- Produces: nothing — this task gates the branch.

- [ ] **Step 1: Syntax-check every changed JavaScript file**

```bash
node --check server/dbHelpers.js
node --check server/dbClient.js
node --check server/dbTests.js
node --check public/js/sync_control.js
node --check public/js/authorized_index.js
node --check scripts/verify-sync.js
```

Expected: exit code 0 for all six, no output.

- [ ] **Step 2: Run the full verification script**

```bash
node scripts/verify-sync.js
```

Expected: thirty-one `ok` lines and exit code 0.

- [ ] **Step 3: Confirm the schema version and the updater list agree**

```bash
node -e "const h=require('./server/dbHelpers');const fs=require('fs');const src=fs.readFileSync('server/dbClient.js','utf8');const defs=(src.match(/^const _version[0-9]+ = async/gm)||[]).length;console.log('dbUserVersion',h.dbUserVersion,'| migration definitions',defs)"
```

Expected: `dbUserVersion 44 | migration definitions 44`. The runtime guard in `server/dbClient.js` throws on a mismatch, so this is a second, independent confirmation.

- [ ] **Step 4: Confirm the module-level guard still passes**

```bash
node -e "require('./server/dbClient');console.log('dbClient loaded, versionUpdaters length matches dbUserVersion')"
```

Expected: `dbClient loaded, versionUpdaters length matches dbUserVersion` and exit code 0.

- [ ] **Step 5: Confirm no stale references remain**

```bash
node -e "const fs=require('fs'),path=require('path');const hits=[];const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(['.js','.ejs'].includes(path.extname(p))){fs.readFileSync(p,'utf8').split('\n').forEach((l,i)=>{if(/freeSyncPeriod|donorSyncPeriod|plusSyncPeriod|premiumSyncPeriod/.test(l))hits.push(p+':'+(i+1))})}}};['server','views','public','scripts'].forEach(walk);if(hits.length){console.error('stale: '+hits.join(', '));process.exit(1)}console.log('no stale sync-period constants')"
```

Expected: `no stale sync-period constants` and exit code 0.

```bash
node -e "const fs=require('fs'),path=require('path');const hits=[];const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(['.js','.ejs','.md'].includes(path.extname(p))){fs.readFileSync(p,'utf8').split('\n').forEach((l,i)=>{if(/Sync once every|allows a sync as often as/.test(l))hits.push(p+':'+(i+1))})}}};['views','public'].forEach(walk);if(hits.length){console.error('stale: '+hits.join(', '));process.exit(1)}console.log('no stale cooldown copy')"
```

Expected: `no stale cooldown copy` and exit code 0. The scan covers `views/` and `public/` only, so the upstream `CHANGELOG.md` history — which still records the old cooldown tiers — is left alone on purpose.

- [ ] **Step 6: Run the real test suite**

MongoDB is not installed here, so `npm test` cannot connect. The suite runs unchanged against an in-memory MongoDB instead. Install it without touching `package.json`:

```bash
npm i --no-save mongodb-memory-server
```

Then run the suite:

```bash
node -e "const {MongoMemoryServer}=require('mongodb-memory-server');(async()=>{const m=await MongoMemoryServer.create({instance:{port:27017,dbName:'graderoom_test'}});const db=require('./server/dbClient.js');await db.config('mongodb://127.0.0.1:27017');const pass=await require('./server/dbTests.js').runAll();console.log(pass?'ALL TESTS PASSED':'TESTS FAILED');await m.stop();process.exit(pass?0:1)})().catch(e=>{console.error('ERR',e.message);process.exit(2)})"
```

Expected: the run prints a line per test — `37 tests passed of 37 tests run.` — and ends with `ALL TESTS PASSED`.

Two `Error handling ...` lines appear mid-run. Those come from `testSocketMalformedPayload`, which deliberately feeds the socket handlers bad payloads to prove they do not throw; they are expected output, not failures.

On a machine with a real MongoDB running, `npm test` is the equivalent command.

- [ ] **Step 7: Push the branch**

```bash
git push origin feat/unlimited-syncs
```

- [ ] **Step 8: Open a pull request inside the fork**

The fork's own copy of this branch is the deliverable, so the pull request targets the fork's `master`, not upstream:

```bash
gh pr create --repo ironwolf-y/graderoom-website --base master --head feat/unlimited-syncs --title "Unlimited syncs" --body "Removes the donation-tier sync cooldown. Every tier syncs on the same one minute floor and the auto-sync cadence defaults to 15 minutes. See docs/superpowers/specs/2026-10-21-unlimited-syncs-design.md."
```

Expected: a URL for the pull request inside the fork.
