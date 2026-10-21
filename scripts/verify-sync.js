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
