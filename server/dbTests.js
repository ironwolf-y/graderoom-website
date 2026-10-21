const db = require("./dbClient");
const _ = require("lodash");
const assert = require("assert");
const {deviceOf} = require("./middleware");

let passCount = 0;
let runCount = 0;

module.exports = {
    runAll: async () => {
        await db.config(null, null, null, true);
        await db.clearTestDatabase();
        let functions = Object.values(module.exports).slice(1);
        passCount = 0;
        runCount = 0;
        for (let func of functions) {
            await func();
        }
        await db.config(); // This just sets testing to false
        return passCount === runCount;
    }, testInit: async () => {
        let result = await db.init();
        customAssert(result, {success: true, data: {}}, "init");
    }, testUserFunctions: async () => {
        let now = new Date();
        let username = randomString(16);
        let password = randomString(1).toUpperCase() + randomString(5).toLowerCase() + randomInt(3);
        let [firstName, lastName] = [randomString(8), randomString(8)];
        let graduationYear = now.getFullYear();
        let schoolUsername = firstName + "." + lastName + graduationYear.toString().slice(2) + "@bcp.org";
        schoolUsername = schoolUsername.toLowerCase();
        let school = "bellarmine";

        customAssert(await db.addUser(school, username, password, schoolUsername, false), {
            success: true,
            data: {message: "User Created"}
        }, "User created");
        customAssert((await db.userExists({username: username})).success, true, "User exists with username");
        customAssert((await db.userExists({schoolUsername: schoolUsername})).success, true, "User exists with schoolUsername");
        customAssert((await db.userExists({username, schoolUsername})).success, true, "User exists with both");
        customAssert((await db.getUser(username, {})).success, true, "Get user");
        // Every key a new user is made with must survive the startup cleanup
        await db.removeUnknownAppearanceKeys();
        customAssert((await db.getUser(username, {appearance: 1})).data.value.appearance,
            require("./dbHelpers").appearanceDefaults, "Startup cleanup keeps known appearance keys");
        customAssert((await db.removeUser("")).success, false, "Invalid user removal");
        customAssert((await db.removeUser(username)).success, true, "Valid user removal");
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
    }, testSyncPeriodMigration: async () => {
        // The real migration, run against real user documents
        const helpers = require("./dbHelpers");
        const oldDefault = 4 * 60 * 60 * 1000;
        const newDefault = 15 * 60 * 1000;
        const currentVersion = helpers.dbUserVersion;
        let now = new Date();
        let year = now.getFullYear().toString().slice(2);

        // makeUser reads the schema version off the helpers module as it builds a user, so a
        // user can be created looking like it predates the migration
        const makeUserAt = async (version) => {
            helpers.dbUserVersion = version;
            try {
                let username = randomString(12).toLowerCase();
                let [firstName, lastName] = [randomString(8), randomString(8)];
                let schoolUsername = (firstName + "." + lastName + year + "@bcp.org").toLowerCase();
                let password = randomString(1).toUpperCase() + randomString(5).toLowerCase() + randomInt(3);
                await db.addUser("bellarmine", username, password, schoolUsername, false);
                return username;
            } finally {
                helpers.dbUserVersion = currentVersion;
            }
        };

        let stale = await makeUserAt(43);
        let chosen = await makeUserAt(43);
        let pending = await makeUserAt(42);
        customAssert((await db.setSyncPeriod(stale, oldDefault)).success, true, "Setup: the old default is stored");
        customAssert((await db.setSyncPeriod(chosen, 24 * 60 * 60 * 1000)).success, true, "Setup: a chosen cadence is stored");
        customAssert((await db.setSyncPeriod(pending, oldDefault)).success, true, "Setup: the pending user's old default is stored");

        // Without a Discord token the version 43 migration is skipped, and that is what
        // leaves a user on version 42. Taking the token away makes that true either way.
        let token = process.env.DISCORD_TOKEN;
        delete process.env.DISCORD_TOKEN;
        let logs = [];
        let realLog = console.log;
        console.log = (...args) => logs.push(args.map(String).join(' '));
        try {
            await db.updateAllUsers();
        } finally {
            console.log = realLog;
            if (token) {
                process.env.DISCORD_TOKEN = token;
            }
        }

        let read = async (username) => (await db.getUser(username, {version: 1, syncPeriod: 1})).data.value;
        let staleUser = await read(stale);
        customAssert(staleUser.version, currentVersion, "A migrated user is on the current schema version");
        customAssert(staleUser.syncPeriod, newDefault, "The old default moves to the new one");
        customAssert((await read(chosen)).syncPeriod, 24 * 60 * 60 * 1000, "A cadence the user chose survives");

        // A user whose version 43 migration was skipped must stay pending: the version and the
        // cadence move together or not at all
        let pendingUser = await read(pending);
        customAssert(pendingUser.version, 42, "A user waiting on version 43 stays pending");
        customAssert(pendingUser.syncPeriod, oldDefault, "A pending user keeps the old cadence");

        // The log must not claim a migration that did not happen
        let pendingLogs = logs.filter(line => line.includes(pending));
        customAssert(pendingLogs.some(line => line.includes("Skipped version 44")), true, "A pending user is logged as skipped");
        customAssert(pendingLogs.some(line => line.includes("Updated") && line.includes("to version 44")), false, "A pending user is not logged as updated");
    }, testDeploymentConfig: async () => {
        const {redisUrl, isBetaServer, httpPort, listenHost} = require("./config");
        // BETA decides the mode outright; without it the port still does, as it always did
        customAssert(isBetaServer(10000, {}), true, "An unassigned port is beta without an explicit choice");
        customAssert(isBetaServer(10000, {BETA: "false"}), false, "BETA=false forces stable on any port");
        customAssert(isBetaServer(10000, {BETA: "true"}), true, "BETA=true forces beta on any port");
        customAssert(isBetaServer(5996, {}), false, "Port 5996 is stable without an explicit choice");
        customAssert(isBetaServer(5998, {}), true, "Port 5998 is beta without an explicit choice");
        // With no port at all there is nothing to infer from, and beta is the surprising answer
        customAssert(isBetaServer(NaN, {}), false, "A missing port is stable, not beta");
        customAssert(isBetaServer(undefined, {}), false, "No port is stable, not beta");
        // An existing local setup has no REDIS_URL and must not change
        customAssert(redisUrl(5996, {}), "redis://127.0.0.1:6379", "Redis falls back to the local port");
        customAssert(redisUrl(5998, {}), "redis://127.0.0.1:6381", "Redis falls back to the local beta port");
        customAssert(redisUrl(5996, {REDIS_URL: "redis://host:6380"}), "redis://host:6380", "REDIS_URL wins");
        // PaaS hosts set PORT in upper case, .env files use port in lower case
        customAssert(httpPort({port: "5996"}), 5996, "A lower case port is read");
        customAssert(httpPort({PORT: "8080"}), 8080, "An upper case PORT is read");
        customAssert(httpPort({PORT: "8080", port: "5996"}), 8080, "PORT wins over port");
        customAssert(listenHost({}), "", "Every interface is listened on by default");
        customAssert(listenHost({HOST: "127.0.0.1"}), "127.0.0.1", "HOST narrows the listener");
    }, testLoadEnvKeepsRealEnvironment: async () => {
        // dotenv must not overwrite a variable the environment already sets
        const {loadEnv} = require("./config");
        let before = process.env.DBLINK_TEST_KEEP;
        process.env.DBLINK_TEST_KEEP = "from-the-environment";
        try {
            loadEnv();
            customAssert(process.env.DBLINK_TEST_KEEP, "from-the-environment", "A real environment variable survives loading .env");
        } finally {
            if (before === undefined) {
                delete process.env.DBLINK_TEST_KEEP;
            } else {
                process.env.DBLINK_TEST_KEEP = before;
            }
        }
    }, testCreateUsers: async () => {
        const fs = require("fs");
        const os = require("os");
        const path = require("path");
        const creator = require("../scripts/create-users");
        let file = path.join(os.tmpdir(), "graderoom-accounts-" + randomString(8) + ".json");
        fs.writeFileSync(file, JSON.stringify([
            {school: "bellarmine", username: "importone", password: "Passw0rdTest", schoolEmail: "import.one26@bcp.org"},
            {school: "bellarmine", username: "importtwo", password: "Passw0rdTest", schoolEmail: "import.two26@bcp.org"},
        ]));
        let accounts = creator.readAccounts(file);
        customAssert(accounts.length, 2, "Both accounts are read");
        let results = await creator.createAccounts(accounts, {school: "bellarmine"});
        customAssert(results.filter(r => r.success).length, 2, "Both accounts are created");
        // Running it again must not fail the batch over an account that already exists
        let again = await creator.createAccounts(accounts, {school: "bellarmine"});
        customAssert(again.length, 2, "A second run still reports every account");
        customAssert(again.filter(r => !r.success).length, 2, "An account that already exists is reported, not fatal");
        customAssert(again.every(r => !!r.message), true, "A failed account says why it failed");
        customAssert((await db.userExists({username: "importone"})).success, true, "The imported user exists");
        // A rejected school email has to say so rather than coming back blank
        let rejected = await creator.createAccounts(
            [{school: "bellarmine", username: "bademail", password: "Passw0rdTest", schoolEmail: "not-a-school-email"}],
            {school: "bellarmine"});
        customAssert(rejected.length, 1, "A rejected account is reported");
        customAssert(rejected[0].success, false, "A bad school email is refused");
        customAssert(!!rejected[0].message, true, "A refused account says why");
        // The server refuses a username over 16 characters, and says nothing about why,
        // so the script has to catch it first
        let tooLong = await creator.createAccounts(
            [{school: "bellarmine", username: "seventeencharslong", password: "Passw0rdTest", schoolEmail: "long.one26@bcp.org"}],
            {school: "bellarmine"});
        customAssert(tooLong[0].success, false, "A username over 16 characters is refused");
        customAssert(tooLong[0].message, "Username must be 16 or fewer characters long.", "A long username says why");
        // The school is stored in lower case everywhere else, and a capitalised one
        // would fail a valid address
        let capitalised = await creator.createAccounts(
            [{school: "Bellarmine", username: "capschool", password: "Passw0rdTest", schoolEmail: "cap.school26@bcp.org"}],
            {school: "Bellarmine"});
        customAssert(capitalised[0].success, true, "A capitalised school name is accepted");
        // A batch with one account that already exists still creates the rest
        let mixed = await creator.createAccounts(
            [{school: "bellarmine", username: "importone", password: "Passw0rdTest", schoolEmail: "import.one26@bcp.org"},
             {school: "bellarmine", username: "importthree", password: "Passw0rdTest", schoolEmail: "import.three26@bcp.org"}],
            {school: "bellarmine"});
        customAssert(mixed.filter(r => r.success).length, 1, "A mixed batch still creates the new account");
        customAssert(mixed.filter(r => !r.success).length, 1, "A mixed batch reports the existing one");
        fs.unlinkSync(file);
    }, testSetPassword: async () => {
        // A forgotten password has to be recoverable without an email server
        let username = "resetme" + randomString(4).toLowerCase();
        await db.addUser("bellarmine", username, "Passw0rdTest", "reset.me26@bcp.org", false);
        customAssert((await db.login(username, "Passw0rdTest")).success, true, "The original password works");
        let res = await db.setPassword(username, "NewPassw0rd");
        customAssert(res.success, true, "The password is set");
        customAssert((await db.login(username, "NewPassw0rd")).success, true, "The new password works");
        customAssert((await db.login(username, "Passw0rdTest")).success, false, "The old password no longer works");
        // The server's own rules still apply
        let weak = await db.setPassword(username, "short");
        customAssert(weak.success, false, "A weak password is refused");
        let missing = await db.setPassword("nosuchuser" + randomString(4).toLowerCase(), "NewPassw0rd");
        customAssert(missing.success, false, "A user that does not exist is refused");
    }, testBetaKeyFunctions: async () => {
        let res = await db.addBetaKey();
        customAssert(res.success, true, "Add beta key");
        let betaKey = res.data.value.betaKey;
        customAssert((await db.betaKeyExists(betaKey)).success, true, "Beta key exists");
        customAssert(await db.getBetaKey(betaKey), {
            success: true,
            data: {value: {betaKey: betaKey, claimed: false, claimedBy: ""}}
        }, "Get beta key");
        let username = randomString(8).toLowerCase();
        customAssert((await db.claimBetaKey(betaKey, username)).success, true, "Beta key claiming");
        customAssert(await db.getBetaKey(betaKey), {
            success: true,
            data: {value: {betaKey: betaKey, claimed: true, claimedBy: username}}
        }, "Get claimed beta key");
        customAssert((await db.removeBetaKey("")).success, false, "Invalid beta key removal");
        await db.removeBetaKey(betaKey);
        customAssert((await db.betaKeyExists(betaKey)).success, false, "Valid beta key removal");
    }, testClassesFunctions: async () => {
        await db.addUser("bellarmine", "hippityhop", "123ThisIsAPassword", "hippity.hop22@bcp.org", false);
        await db.addUser("bellarmine", "hoppityhip", "123ThisIsAPassword", "hoppity.hip22@bcp.org", false);

        await db.addDbClass("bellarmine", "21-22", "S2", "Science", "Alex Smith");
        await db.addDbClass("bellarmine", "21-22", "S2", "Science", "Alex Smith");
        await db.addDbClass("basis", "21-22", "S2", "Science", "Alex Smith");
        await db.addDbClass("bellarmine", "21-22", "S2", "Science", "Bob Jones");
        await db.addDbClass("bellarmine", "21-22", "S2", "Math", "Sally G");

        customAssert(Object.keys((await db.getAllClassData("bellarmine", "21-22", "S2")).data.classData), ["Science", "Math"], "Add db classes");
        customAssert(Object.keys((await db.getAllClassData("basis", "21-22", "S2")).data.classData), ["Science"], "Add db classes");

        await db.addWeightsSuggestion("hippityhop", "21-22", "S2", "Science", "Alex Smith", true, {"Tests": 100});
        await db.addWeightsSuggestion("hoppityhip", "21-22", "S2", "Science", "Alex Smith", true, {"Tests": 100});
        await db.addWeightsSuggestion("hoppityhip", "21-22", "S2", "Science", "Bob Jones", true, {"Projects": 100});
        await db.addWeightsSuggestion("hoppityhip", "21-22", "S2", "Math", "Sally G", true, {"Quizzes": 100});
        await db.addWeightsSuggestion("hoppityhip", "21-22", "S2", "Math", "Sally G", true, {"Sleep": 100});

        console.log(await db.getMostRecentTermDataInClassDb("bellarmine"));
        customAssert((await db.dbContainsSemester("bellarmine", "21-22", "S2")).success, true, "Valid contained semester");
        customAssert((await db.dbContainsSemester("bellarmine", "21-22", "S1")).success, false, "Invalid contained semester");
        customAssert((await db.dbContainsClass("bellarmine", "21-22", "S2", "Math", "Sally G")).success, true, "Valid contained class");
        customAssert((await db.dbContainsClass("bellarmine", "21-22", "S2", "Math", "Joel J")).success, false, "Invalid contained class");
    }, testDeviceOf: async () => {
        // A phone that reads as a desktop keeps the effects running on it, and a desktop that
        // reads as a phone loses them, so the two headers this picks between are worth pinning
        let req = (ua, hint) => ({get: header => header === "user-agent" ? ua : hint});
        let iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
        let android = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36";
        let windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";
        let mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";
        customAssert(deviceOf(req(iphone)), {os: "ios", mobile: true, key: "ios-mobile"}, "iPhone");
        customAssert(deviceOf(req(android, "?1")), {os: "android", mobile: true, key: "android-mobile"}, "Android");
        customAssert(deviceOf(req(windows, "?0")), {os: "windows", mobile: false, key: "windows"}, "Windows");
        customAssert(deviceOf(req(mac)), {os: "macos", mobile: false, key: "macos"}, "Mac with no hint");
        // The hint is the browser answering the question, so it beats anything read off the string
        customAssert(deviceOf(req(android, "?0")), {os: "android", mobile: false, key: "android"}, "Android asking for the desktop site");
        customAssert(deviceOf(req("")), {os: "other", mobile: false, key: "other"}, "No User-Agent at all");
    }, testSocketMalformedPayload: async () => {
        // A handler that throws on a bad payload is an unhandled rejection, which kills the process
        let handlers = {};
        let socket = {on: (event, fn) => handlers[event] = fn, onAny: () => {}, request: {user: {username: "x"}, headers: {}}};
        require("./socket").setupSocket(socket);
        let rejections = 0;
        let count = () => rejections++;
        process.on("unhandledRejection", count);
        handlers["settings-change"]({unknownKey: 1});
        handlers["settings-change"](null);
        handlers["start-update"](undefined);
        await new Promise(resolve => setTimeout(resolve, 100));
        process.off("unhandledRejection", count);
        customAssert(rejections, 0, "Malformed socket payloads do not crash the server");
    }, testScraperQueuePositions: async () => {
        // Only waiting users hear their place in line, never the one whose sync is running
        const {ScraperAutoQueue} = require("./data_structures/queue/scraper_auto_queue");
        let queue = new ScraperAutoQueue();
        let heard = {a: [], b: [], c: []};
        let release;
        let gate = new Promise(resolve => release = resolve);
        queue.enqueue(() => gate, m => heard.a.push(m.message));
        queue.enqueue(async () => {}, m => heard.b.push(m.message));
        queue.enqueue(async () => {}, m => heard.c.push(m.message));
        customAssert(heard, {
            a: [],
            b: ["Waiting in queue. You are next in line."],
            c: ["Waiting in queue. You are number 2 in line."]
        }, "Queue positions go to the waiting users");
        release();
        await new Promise(resolve => setTimeout(resolve, 50));
        customAssert(heard.c[1], "Waiting in queue. You are next in line.", "Queue moves up when a sync finishes");
    }, testEmitToRoomRetry: async () => {
        // A user whose room isn't ready on the first try (mid-reload) must still get the message
        const socketManager = require("./socketManager");
        let rooms = new Map();
        let sent = [];
        socketManager.setIo({sockets: {adapter: {rooms}}, to: () => ({emit: (event) => sent.push(event)})});
        socketManager.emitToRoom("late", "hello");
        rooms.set("late", new Set());
        await new Promise(resolve => setTimeout(resolve, 1600));
        socketManager.setIo(undefined);
        customAssert(sent, ["hello"], "Message sent after the room appears on a retry");
    }
};

// Helpers
function customAssert(value1, value2, testName) {
    try {
        assert(_.isEqual(value1, value2));
        passCount++;
    } catch (e) {
        console.error(`${testName} FAILED`);
        console.log(value1);
        console.log(value2);
    } finally {
        runCount++;
        console.log(`${passCount} tests passed of ${runCount} tests run.`);
    }
}

function randomString(length) {
    let result = "";
    let characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}

function randomInt(length) {
    let result = "";
    let characters = "0123456789";
    let charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return parseInt(result);
}

function randomBool() {
    return Math.floor(Math.random() * 2) === 0;
}

