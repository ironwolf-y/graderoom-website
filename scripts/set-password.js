// Sets a user's password without the old one, so an instance owner can get someone
// back in without an email server.
//
//   node scripts/set-password.js <username> [new password]
//
// With no password given, it asks for one. This is an owner-level operation: it needs
// shell access to the machine the server runs on, and no route reaches it.
const readline = require('readline');
const dbClient = require("../server/dbClient");
const {loadEnv, isBetaServer, httpPort} = require("../server/config");

const promptPassword = function (username) {
    let rl = readline.createInterface({input: process.stdin, output: process.stdout, terminal: true});
    let muted = true;
    rl._writeToOutput = function (text) {
        rl.output.write(muted ? '*' : text);
    };
    return new Promise(resolve => {
        rl.question(`New password for ${username}: `, answer => {
            muted = false;
            rl.close();
            console.log();
            resolve(answer);
        });
    });
};

const main = async function () {
    let username = process.argv[2];
    if (!username) {
        console.error("usage: node scripts/set-password.js <username> [new password]");
        process.exit(2);
    }
    loadEnv();
    let password = process.argv[3];
    if (!password) {
        password = await promptPassword(username);
    }
    let url = process.env.DB_URL || "mongodb://127.0.0.1:27017";
    await dbClient.config(url, process.env.NODE_ENV === "production", isBetaServer(httpPort()));
    let res = await dbClient.setPassword(username, password);
    if (!res.success) {
        console.error(`failed  ${username}: ${res.data?.message || "Could not set the password"}`);
        process.exit(1);
    }
    console.log(`password set for ${username}`);
    // The database connection keeps the process alive, so it has to be closed by hand
    process.exit(0);
};

if (require.main === module) {
    main().catch(e => {
        console.error(e.message);
        process.exit(1);
    });
}
