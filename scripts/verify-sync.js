// Standalone checks for this fork's sync behaviour. Runs without MongoDB and without
// a browser:   node scripts/verify-sync.js
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (label, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
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

const syncTickDelay = new Function('remaining', extract('public/js/sync_control.js', 'syncTickDelay', 4));

check('no deadline waits a minute', syncTickDelay(0), 60000);
check('a passed deadline waits a minute', syncTickDelay(-5), 60000);
check('inside the floor it repaints every second', syncTickDelay(45000), 1000);
check('at the floor it repaints every second', syncTickDelay(60000), 1000);
check('just under two minutes it repaints every second', syncTickDelay(119999), 1000);
check('two minutes out it waits a minute', syncTickDelay(120000), 60000);
check('fifteen minutes out it waits a minute', syncTickDelay(900000), 60000);

process.exit(failures ? 1 : 0);
