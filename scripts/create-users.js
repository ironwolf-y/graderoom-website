// Creates accounts straight in the database, so a private instance needs no reCAPTCHA
// and no Google Cloud project.
//
//   node scripts/create-users.js accounts.json
//
// The file is a JSON array:
//   [{"school": "bellarmine", "username": "jdoe", "password": "Passw0rd", "schoolEmail": "jane.doe26@bcp.org"}]
//
// A password may also be given as "password": null, which asks for one to be typed in.
// The rules are the server's own, checked here with the same validators the signup
// page uses, so a rejected account says exactly what is wrong with it.
const fs = require('fs');
const readline = require('readline');
const dbClient = require("../server/dbClient");
const {loadEnv, isBetaServer, httpPort} = require("../server/config");
const {validateUsername, validatePassword, validateEmail} = require("../server/dbHelpers");

exports.readAccounts = function (file) {
    let accounts = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(accounts)) {
        throw new Error("The accounts file must contain a JSON array");
    }
    return accounts;
};

/**
 * Why this account cannot be created, or null when it is fine.
 * @param {Object} account
 * @param {string} school
 * @param {string} password
 * @returns {string|null}
 */
exports.checkAccount = function (account, school, password) {
    if (!account.username || !validateUsername(account.username)) {
        return "Username must contain only lowercase letters and numbers.";
    }
    if (account.username.length > 16) {
        return "Username must be 16 or fewer characters long.";
    }
    let passwordProblem = validatePassword(password);
    if (passwordProblem) {
        return passwordProblem;
    }
    if (!account.schoolEmail || !validateEmail(account.schoolEmail, school)) {
        return `This must be your ${school[0].toUpperCase() + school.substring(1)} school email.`;
    }
    return null;
};

exports.createAccounts = async function (accounts, {school} = {}) {
    let results = [];
    for (let account of accounts) {
        // The school is stored in lower case everywhere else, and the validators expect it
        let accountSchool = (account.school || school || "").toLowerCase();
        if (!accountSchool) {
            results.push({username: account.username, success: false, message: "No school given"});
            continue;
        }
        let password = account.password;
        if (!password) {
            password = await promptPassword(account.username);
        }
        // The server drops the reason a call failed, so it is checked here first
        let problem = exports.checkAccount(account, accountSchool, password);
        if (problem) {
            results.push({username: account.username, success: false, message: problem});
            continue;
        }
        let res = await dbClient.addUser(accountSchool, account.username, password, account.schoolEmail, !!account.isAdmin);
        results.push({
            username: account.username,
            success: res.success,
            message: res.data?.message || (res.success ? "" : "Could not create the account.")
        });
    }
    return results;
};

const promptPassword = function (username) {
    let rl = readline.createInterface({input: process.stdin, output: process.stdout, terminal: true});
    // Readline echoes what is typed. A password should not be on screen.
    let muted = true;
    rl._writeToOutput = function (text) {
        rl.output.write(muted ? '*' : text);
    };
    return new Promise(resolve => {
        rl.question(`Password for ${username}: `, answer => {
            muted = false;
            rl.close();
            console.log();
            resolve(answer);
        });
    });
};

const main = async function () {
    let file = process.argv[2];
    if (!file) {
        console.error("usage: node scripts/create-users.js <accounts.json>");
        process.exit(2);
    }
    loadEnv();
    let url = process.env.DB_URL || "mongodb://127.0.0.1:27017";
    await dbClient.config(url, process.env.NODE_ENV === "production", isBetaServer(httpPort()));
    let accounts = exports.readAccounts(file);
    let results = await exports.createAccounts(accounts);
    let failed = 0;
    for (let result of results) {
        if (result.success) {
            console.log(`created ${result.username}`);
        } else {
            failed++;
            console.error(`failed  ${result.username}: ${result.message}`);
        }
    }
    console.log(`${results.length - failed} created, ${failed} failed`);
    process.exit(failed ? 1 : 0);
};

if (require.main === module) {
    main().catch(e => {
        console.error(e.message);
        process.exit(1);
    });
}
