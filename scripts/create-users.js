// Creates accounts straight in the database, so a private instance needs no reCAPTCHA
// and no Google Cloud project.
//
//   node scripts/create-users.js accounts.json
//
// The file is a JSON array:
//   [{"school": "bellarmine", "username": "jdoe", "password": "Passw0rd", "schoolEmail": "jane.doe26@bcp.org"}]
//
// A password may also be given as "password": null, which asks for one to be typed in.
// The rules the server enforces are the ones the signup page enforces: a lowercase
// letters-and-digits username, a password of 6 to 64 characters with a lowercase, an
// uppercase and a digit in it, and a school email of the right shape.
const fs = require('fs');
const readline = require('readline');
const dbClient = require("../server/dbClient");

exports.readAccounts = function (file) {
    let accounts = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(accounts)) {
        throw new Error("The accounts file must contain a JSON array");
    }
    return accounts;
};

exports.createAccounts = async function (accounts, {school} = {}) {
    let results = [];
    for (let account of accounts) {
        let accountSchool = account.school || school;
        if (!accountSchool) {
            results.push({username: account.username, success: false, message: "No school given"});
            continue;
        }
        let password = account.password;
        if (!password) {
            password = await promptPassword(account.username);
        }
        let res = await dbClient.addUser(accountSchool, account.username, password, account.schoolEmail, !!account.isAdmin);
        results.push({username: account.username, success: res.success, message: res.data?.message});
    }
    return results;
};

const promptPassword = function (username) {
    let rl = readline.createInterface({input: process.stdin, output: process.stdout, terminal: true});
    return new Promise(resolve => {
        rl.question(`Password for ${username}: `, answer => {
            rl.close();
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
    let url = process.env.DB_URL || "mongodb://127.0.0.1:27017";
    await dbClient.config(url, process.env.NODE_ENV === "production", process.env.BETA === "true");
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
    main();
}
