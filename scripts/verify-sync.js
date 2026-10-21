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
// The real decision, not a copy of it: the migration and these checks call the same
// function, so a change to the migration shows up here.
check('the old default moves to 15 minutes',
    helpers.version44Update({version: 43, syncPeriod: helpers.previousDefaultSyncPeriod}),
    {version: 44, syncPeriod: helpers.defaultSyncPeriod});
check('a deliberate 30 minute choice survives',
    helpers.version44Update({version: 43, syncPeriod: 30 * 60 * 1000}),
    {version: 44});
check('a deliberate 24 hour choice survives',
    helpers.version44Update({version: 43, syncPeriod: 24 * 60 * 60 * 1000}),
    {version: 44});
check('a user pending on version 42 stays pending',
    helpers.version44Update({version: 42, syncPeriod: helpers.previousDefaultSyncPeriod}),
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

const syncPeriodText = new Function('syncInterval', extract('public/js/sync_control.js', 'syncPeriodText', 4));
check('a one minute cadence reads as a minute', syncPeriodText(60000), 'minute');
check('a fifteen minute cadence reads in minutes', syncPeriodText(900000), '15 minutes');
check('an hourly cadence reads as an hour', syncPeriodText(3600000), 'hour');
check('a daily cadence reads as a day', syncPeriodText(86400000), 'day');
check('no cadence reads as nothing', syncPeriodText(0), null);

// ---- the non-Bellarmine wait message ------------------------------------------
const getLimitMessage = new Function('timestamp', extract('public/js/authorized_index.js', 'getLimitMessage', 8));
const messageNow = Date.now();
check('the wait message reads in seconds',
    getLimitMessage(messageNow + 45000),
    'You need to wait 45s before syncing again.');
check('the wait message still reads in minutes',
    getLimitMessage(messageNow + 5 * 60000),
    'You need to wait 5m before syncing again.');
check('a deadline already passed does not read as a negative wait',
    getLimitMessage(messageNow - 5000),
    'You can sync again now.');

// ---- the copy that quotes a cooldown ------------------------------------------
// The donation copy used to quote a tier cooldown. It must not go back to that.
const copyFiles = [
    'views/partials/user/settings_card.ejs',
    'public/js/sync_control.js',
    'public/js/authorized_index.js',
];
const bannedCopy = ['Sync once every', 'allows a sync as often as'];
for (const file of copyFiles) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const banned of bannedCopy) {
        check(`${file} does not quote "${banned}"`, text.includes(banned), false);
    }
}

// The tier constants are gone; nothing may still name them. The names are built in
// pieces so this file does not name them either.
const removedConstants = ['free', 'donor', 'plus', 'premium'].map(tier => tier + 'SyncPeriod');
let staleConstant = [];
const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full);
        } else if (['.js', '.ejs'].includes(path.extname(entry.name))) {
            fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
                if (removedConstants.some(name => line.includes(name))) {
                    staleConstant.push(`${full}:${i + 1}`);
                }
            });
        }
    }
};
['server', 'views', 'public', 'scripts'].forEach(d => walk(path.join(__dirname, '..', d)));
check('no file still names a removed tier constant', staleConstant, []);

process.exit(failures ? 1 : 0);
