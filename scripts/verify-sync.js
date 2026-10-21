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

process.exit(failures ? 1 : 0);
