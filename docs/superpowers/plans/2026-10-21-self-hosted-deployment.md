# Self-Hosted Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make this fork runnable for about five people on a free host, with no Google Cloud, no OCI email account and no Python.

**Architecture:** Three small server-side changes (a configurable Redis URL, explicit beta mode, a `.env` file that works in production) plus a script that creates accounts without reCAPTCHA, plus a patched build of the browser extension pinned to the instance's origin. The runbook ties it together.

**Tech Stack:** Node.js (CommonJS), Express, Socket.io, MongoDB, Redis, systemd, Cloudflare Tunnel, Chrome MV3 / Firefox MV3 extensions.

**Spec:** `docs/superpowers/specs/2026-10-21-self-hosted-deployment-design.md`

## Global Constraints

- `REDIS_URL` falls back to `redis://127.0.0.1:${httpPort + 383}` when unset, so every existing local setup keeps working.
- `BETA=true` forces beta mode, `BETA=false` forces stable, and `BETA` unset keeps the old port-derived behaviour (`httpPort !== 5996`).
- `dotenv` must not override variables that are already set in the real environment.
- The extension's Chrome ID must be the same on every user's machine, so the manifest carries a pinned `key`.
- `TEST_EXTENSION_ID` is how the page finds a custom extension build; it already exists and must keep working.
- The project's test suite is `server/dbTests.js`, run by `npm test` and by CI on every push. It needs MongoDB, so in this environment it runs against an in-memory MongoDB.
- New configuration logic goes in `server/config.js` as pure functions so it can be tested without starting a server.

## Review Focus

1. **A host that assigns the port** (Render, Railway, a reverse proxy) — the app must not silently flip into beta mode, because beta mode needs a beta key to sign up and uses a different database.
2. **An existing local setup with no `REDIS_URL` and no `BETA`** — behaviour must be byte-for-byte what it was before this change.
3. **A user whose environment already sets `DB_URL`** — loading `.env` in production must not override the real value.
4. **Two people installing the extension on different machines** — they must get the same extension ID, or the single `TEST_EXTENSION_ID` on the server will only work for one of them.
5. **A second run of the account-creation script** — it must not fail the whole batch because one account already exists.

---

## Task 1: Configurable Redis URL and production `.env`

**Files:**
- Create: `server/config.js`
- Modify: `server/graderoom.js:5-7` (dotenv), `server/graderoom.js:67-68` (redis url)
- Test: `server/dbTests.js` (new `testDeploymentConfig`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `server/config.js` → `exports.redisUrl(httpPort: number, env: Object): string`
  - `server/config.js` → `exports.isBetaServer(httpPort: number, env: Object): boolean`
  - `server/config.js` → `exports.loadEnv(): void` — loads `.env` without overriding real environment variables.

- [ ] **Step 1: Write the failing test**

Add to `server/dbTests.js`, after `testSyncPeriodMigration`:

```js
    }, testDeploymentConfig: async () => {
        const {redisUrl, isBetaServer} = require("./config");
        // A host that assigns the port must not silently become a beta server
        customAssert(isBetaServer(10000, {}), true, "An unassigned port is beta without an explicit choice");
        customAssert(isBetaServer(10000, {BETA: "false"}), false, "BETA=false forces stable on any port");
        customAssert(isBetaServer(10000, {BETA: "true"}), true, "BETA=true forces beta on any port");
        customAssert(isBetaServer(5996, {}), false, "Port 5996 is stable without an explicit choice");
        customAssert(isBetaServer(5998, {}), true, "Port 5998 is beta without an explicit choice");
        // An existing local setup has no REDIS_URL and must not change
        customAssert(redisUrl(5996, {}), "redis://127.0.0.1:6379", "Redis falls back to the local port");
        customAssert(redisUrl(5998, {}), "redis://127.0.0.1:6381", "Redis falls back to the local beta port");
        customAssert(redisUrl(5996, {REDIS_URL: "redis://host:6380"}), "redis://host:6380", "REDIS_URL wins");
    },
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node -e "const {MongoMemoryServer}=require('mongodb-memory-server');(async()=>{const m=await MongoMemoryServer.create({instance:{port:27017,dbName:'graderoom_test'}});const db=require('./server/dbClient.js');await db.config('mongodb://127.0.0.1:27017');const pass=await require('./server/dbTests.js').runAll();console.log(pass?'ALL TESTS PASSED':'TESTS FAILED');await m.stop();process.exit(pass?0:1)})().catch(e=>{console.error('ERR',e.message);process.exit(2)})"
```

Expected: FAIL — `Cannot find module './config'` — and the server does not start.

- [ ] **Step 3: Create `server/config.js`**

```js
// Deployment decisions, kept pure so they can be tested without starting a server.

/**
 * Where the session store lives. A hosted Redis has to be reachable by URL, so
 * REDIS_URL wins; without it the port-derived local default is used, which keeps
 * every existing local setup working unchanged.
 * @param {number} httpPort
 * @param {Object} env
 * @returns {string}
 */
exports.redisUrl = function (httpPort, env = process.env) {
    return env.REDIS_URL || `redis://127.0.0.1:${httpPort + 383}`;
};

/**
 * Whether this is the beta server. It used to be inferred from the port, which put
 * every host that assigns a port into beta mode, and beta mode needs a beta key to
 * sign up and uses a different database. BETA now says so explicitly; leaving it
 * unset keeps the old behaviour.
 * @param {number} httpPort
 * @param {Object} env
 * @returns {boolean}
 */
exports.isBetaServer = function (httpPort, env = process.env) {
    if (env.BETA !== undefined && env.BETA !== "") {
        return env.BETA === "true";
    }
    return httpPort !== 5996;
};

/**
 * Load the .env file. dotenv does not overwrite variables that are already set, so a
 * real environment always wins over the file.
 */
exports.loadEnv = function () {
    require("dotenv").config();
};
```

- [ ] **Step 4: Wire it into `server/graderoom.js`**

Replace lines 4-9:

```js
const productionEnv = process.env.NODE_ENV === "production";
if (!productionEnv) {
    require("dotenv").config();
}
const httpPort = parseInt(process.env.port);
const isBetaServer = httpPort !== 5996;
```

with:

```js
const {loadEnv, redisUrl, isBetaServer: betaFromEnv} = require("./config");
loadEnv();
const productionEnv = process.env.NODE_ENV === "production";
const httpPort = parseInt(process.env.port);
const isBetaServer = betaFromEnv(httpPort);
```

Replace lines 67-68:

```js
        let redisPort = httpPort + 383; // 6379 for stable, 6381 for beta
        let redisClient = redis.createClient({url: `redis://127.0.0.1:${redisPort}`});
```

with:

```js
        let redisClient = redis.createClient({url: redisUrl(httpPort)});
```

- [ ] **Step 5: Verify the test passes**

Run the Step 2 command again.

Expected: `ALL TESTS PASSED`.

- [ ] **Step 6: Commit**

```bash
git add server/config.js server/graderoom.js server/dbTests.js
git commit -m "feat: make the Redis URL and beta mode configurable

A hosted Redis cannot be reached on 127.0.0.1, and a host that assigns the
port used to flip the server into beta mode, which needs a beta key to sign
up and uses a different database. REDIS_URL and BETA now say so explicitly,
and the .env file is loaded in production too, where dotenv still lets a
real environment win.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Account creation without reCAPTCHA

**Files:**
- Create: `scripts/create-users.js`
- Test: `server/dbTests.js` (new `testCreateUsers`)

**Interfaces:**
- Consumes: `server/dbClient.js` → `addUser(school, username, password, schoolUsername, isAdmin, beta, betaKey)` and `config(url, prod, beta, testing)`.
- Produces: `scripts/create-users.js` → `exports.readAccounts(file): Array<{school, username, password, schoolEmail}>` and `exports.createAccounts(accounts, {school}): Promise<Array<{username, success, message}>>`, plus a CLI entry point.

- [ ] **Step 1: Write the failing test**

Add to `server/dbTests.js`:

```js
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
        customAssert((await db.userExists({username: "importone"})).success, true, "The imported user exists");
        fs.unlinkSync(file);
    },
```

- [ ] **Step 2: Run the test to verify it fails**

Run the Task 1 Step 2 command.

Expected: FAIL — `Cannot find module '../scripts/create-users'`.

- [ ] **Step 3: Create `scripts/create-users.js`**

```js
// Creates accounts straight in the database, so a private instance needs no reCAPTCHA
// and no Google Cloud project.
//
//   node scripts/create-users.js accounts.json
//
// The file is a JSON array:
//   [{"school": "bellarmine", "username": "jdoe", "password": "Passw0rd", "schoolEmail": "jane.doe26@bcp.org"}]
//
// A password may also be given as "password": null, which asks for one to be typed in.
const fs = require("fs');
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
```

- [ ] **Step 4: Verify the test passes**

Run the Task 1 Step 2 command.

Expected: `ALL TESTS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add scripts/create-users.js server/dbTests.js
git commit -m "feat: create accounts without reCAPTCHA

reCAPTCHA Enterprise is only used by the signup route, so a private
instance can create its accounts directly and need no Google Cloud project
or API key. The script goes through the same addUser the signup route uses,
so every validation rule still applies.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: The extension, pinned to the instance's origin

**Files:**
- Create: `scripts/generate-extension-key.js` (in the extension fork)
- Modify: `debug-manifest.js` (in the extension fork)

**Interfaces:**
- Consumes: the extension fork at `ironwolf-y/graderoom-extension`.
- Produces: `debug-manifest.js` reads `GRADEROOM_ORIGIN` and `GRADEROOM_EXTENSION_KEY` from the environment; `scripts/generate-extension-key.js` writes a pinned key into a manifest and prints the Chrome extension ID.

- [ ] **Step 1: Fork the extension repository**

```bash
gh repo fork graderoom/graderoom-extension --clone=false
```

Expected: `https://github.com/ironwolf-y/graderoom-extension`.

- [ ] **Step 2: Make the manifest patch take the origin**

In the extension fork, replace `debug-manifest.js` with:

```js
// Rewrites the manifest for an instance that is not graderoom.me.
//
//   GRADEROOM_ORIGIN=https://my.instance.example node debug-manifest.js path/to/manifest.json
//
// GRADEROOM_ORIGIN replaces https://*.graderoom.me/* everywhere it appears, which
// covers Chrome's externally_connectable and Firefox's content scripts. Leaving it
// unset keeps the original pattern and adds localhost, for local development.
//
// GRADEROOM_EXTENSION_KEY pins the Chrome extension ID, so the ID is the same on
// every machine instead of being a hash of the install path.
const fs = require('fs');
const path = require('path');

const site = process.env.GRADEROOM_ORIGIN || 'https://*.graderoom.me/*';
const local = ['http://localhost/*', 'http://127.0.0.1/*'];
const key = process.env.GRADEROOM_EXTENSION_KEY;

function addLocalhost(node) {
    if (Array.isArray(node)) {
        if (node.includes('https://*.graderoom.me/*')) {
            node.push(...local.filter(pattern => !node.includes(pattern)));
            return;
        }
        node.forEach(addLocalhost);
    } else if (node && typeof node === 'object') {
        Object.values(node).forEach(addLocalhost);
    }
}

function replaceSite(node) {
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
            if (node[i] === 'https://*.graderoom.me/*') {
                node[i] = site;
            }
        }
    } else if (node && typeof node === 'object') {
        Object.values(node).forEach(replaceSite);
    }
}

const manifestPath = process.argv[2];
if (!manifestPath) {
    console.error('usage: node debug-manifest.js <manifest.json>');
    process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
addLocalhost(manifest);
replaceSite(manifest);
if (key) {
    manifest.key = key;
}
if (process.env.GRADEROOM_EXTENSION_NAME) {
    manifest.name = process.env.GRADEROOM_EXTENSION_NAME;
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Patched ${manifestPath} for ${site}`);
```

- [ ] **Step 3: Add the key generator**

Create `scripts/generate-extension-key.js` in the extension fork:

```js
// Generates a keypair that pins the Chrome extension ID, so every user who installs
// the build gets the same ID and one TEST_EXTENSION_ID on the server works for all of
// them.
//
//   node scripts/generate-extension-key.js path/to/manifest.json
//
// It writes the public key into the manifest and prints the extension ID to put in
// the server's TEST_EXTENSION_ID.
const fs = require('fs');
const crypto = require('crypto');

const manifestPath = process.argv[2];
if (!manifestPath) {
    console.error('usage: node scripts/generate-extension-key.js <manifest.json>');
    process.exit(2);
}

const {publicKey, privateKey} = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {type: 'spki', format: 'der'},
    privateKeyEncoding: {type: 'pkcs8', format: 'pem'},
});

// Chrome derives the extension ID from the first 128 bits of the SHA-256 of the
// DER public key, mapping each hex digit onto a to p.
const digest = crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 32);
const extensionId = [...digest].map(c => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.key = publicKey.toString('base64');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const privateKeyPath = manifestPath.replace(/\.json$/, '') + '.key.pem';
fs.writeFileSync(privateKeyPath, privateKey);
console.log('extension id: ' + extensionId);
console.log('private key:  ' + privateKeyPath + ' (keep this, it is what signs a packaged build)');
```

- [ ] **Step 4: Verify the patch works**

```bash
cd <extension-fork>
node scripts/generate-extension-key.js chrome/manifest.json
GRADEROOM_ORIGIN=https://my.instance.example node debug-manifest.js chrome/manifest.json
node -e "const m=require('./chrome/manifest.json');console.log(JSON.stringify(m.externally_connectable));console.log('key set:', !!m.key)"
```

Expected: an extension id, then `{"matches":["https://my.instance.example/*"]}` and `key set: true`.

- [ ] **Step 5: Commit and push**

```bash
git add debug-manifest.js scripts/generate-extension-key.js
git commit -m "feat: build the extension for a self-hosted instance

The extension is pinned to https://*.graderoom.me/*, so a page served from
anywhere else cannot talk to it. The origin is now a parameter, and a
generated key pins the Chrome extension ID so every user installs the same
one.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push origin master
```

---

## Task 4: Deployment artifacts and runbook

**Files:**
- Create: `deploy/graderoom.service`
- Create: `deploy/graderoom.env.example`
- Create: `deploy/cloudflared-config.yml.example`
- Create: `deploy/backup-mongo.sh`
- Create: `docs/DEPLOYMENT.md`

**Interfaces:**
- Consumes: `server/config.js` → `REDIS_URL`, `BETA`; the server's `DB_URL`, `SECRET`, `port`, `NODE_ENV`.
- Produces: a runbook plus four files a self-hoster can copy and edit.

- [ ] **Step 1: Write the systemd unit**

`deploy/graderoom.service`:

```ini
[Unit]
Description=Graderoom
After=network.target mongod.service redis-server.service
Wants=mongod.service redis-server.service

[Service]
Type=simple
User=graderoom
WorkingDirectory=/opt/graderoom
Environment=NODE_ENV=production
EnvironmentFile=/etc/graderoom.env
ExecStart=/usr/bin/node server/graderoom.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Write the environment file template**

`deploy/graderoom.env.example`:

```ini
# The port decides the database when BETA is unset, so leave it at 5996 for a
# stable instance. BETA=false forces stable on any port.
port=5996
BETA=false

# Random string, long. Changing it logs everyone out.
SECRET=change-me-to-a-long-random-string

# MongoDB. Atlas M0 is free forever at 512 MB.
DB_URL=mongodb://127.0.0.1:27017

# Redis. Leave REDIS_URL unset when Redis is on the same machine.
REDIS_URL=redis://127.0.0.1:6379

# Only needed for password reset by email. Leave blank to skip it.
SMTP_HOST=
SMTP_USER=
SMTP_PASS=

# Only needed if people sign up through the site. The create-users script does
# not need them.
RECAPTCHA_SITE_KEY=
RECAPTCHA_PROJECT_ID=
RECAPTCHA_API_KEY=

# The Chrome extension ID of the build your users install.
TEST_EXTENSION_ID=
```

- [ ] **Step 3: Write the Cloudflare Tunnel config template**

`deploy/cloudflared-config.yml.example`:

```yaml
# A named tunnel gives a stable HTTPS hostname with no public IP on your machine.
#   cloudflared tunnel login
#   cloudflared tunnel create graderoom
#   cloudflared tunnel route dns graderoom grades.example.com
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json

ingress:
  - hostname: grades.example.com
    service: http://127.0.0.1:5996
    originRequest:
      noTLSVerify: true
  - service: http_status:404
```

- [ ] **Step 4: Write the backup script**

`deploy/backup-mongo.sh`:

```bash
#!/bin/sh
# Nightly MongoDB dump. Grades are the only thing worth losing sleep over, and a
# free-tier instance can be reclaimed out from under you.
set -eu
BACKUP_DIR=${BACKUP_DIR:-/var/backups/graderoom}
KEEP_DAYS=${KEEP_DAYS:-14}
DB_URL=${DB_URL:-mongodb://127.0.0.1:27017}
STABLE_DB=${STABLE_DB:-stable}

mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/graderoom-$STAMP"

mongodump --uri="$DB_URL" --db="$STABLE_DB" --out="$OUT" --gzip
tar -czf "$OUT.tar.gz" -C "$BACKUP_DIR" "$(basename "$OUT")"
rm -rf "$OUT"

find "$BACKUP_DIR" -name 'graderoom-*.tar.gz' -mtime "+$KEEP_DAYS" -delete
echo "backed up to $OUT.tar.gz"
```

- [ ] **Step 5: Write the runbook**

`docs/DEPLOYMENT.md` covering: what the instance needs, the host choices, a full
install on a machine you control, the Cloudflare Tunnel, the extension build for the
five users, creating the accounts, the backup, and the things that will need attention
(the `graderoom.me` strings in the mail templates and the support addresses).

- [ ] **Step 6: Commit**

```bash
git add deploy docs/DEPLOYMENT.md
git commit -m "docs: runbook and deployment files for a private instance

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Whole-branch verification

**Files:**
- Verify: every file changed by Tasks 1-4.

- [ ] **Step 1: Syntax-check every changed JavaScript file**

```bash
node --check server/config.js
node --check server/graderoom.js
node --check server/dbTests.js
node --check scripts/create-users.js
```

Expected: exit code 0 for all four, no output.

- [ ] **Step 2: Run the real test suite**

Run the Task 1 Step 2 command.

Expected: `ALL TESTS PASSED`.

- [ ] **Step 3: Verify the fallbacks did not change**

```bash
node -e "const c=require('./server/config');console.log('local stable redis:',c.redisUrl(5996,{}));console.log('local beta redis:',c.redisUrl(5998,{}));console.log('port 5996 beta?',c.isBetaServer(5996,{}));console.log('random port beta?',c.isBetaServer(10000,{}));console.log('BETA=false on random port beta?',c.isBetaServer(10000,{BETA:'false'}))"
```

Expected:

```
local stable redis: redis://127.0.0.1:6379
local beta redis: redis://127.0.0.1:6381
port 5996 beta? false
random port beta? true
BETA=false on random port beta? false
```

- [ ] **Step 4: Verify the account script's help path**

```bash
node scripts/create-users.js
```

Expected: `usage: node scripts/create-users.js <accounts.json>` and exit code 2.

- [ ] **Step 5: Push and open the pull request**

```bash
git push origin feat/self-hosted-deployment
gh pr create --repo ironwolf-y/graderoom-website --base feat/unlimited-syncs --head feat/self-hosted-deployment --title "Self-hosted deployment" --body "..."
```

The pull request targets the fork's own feature branch, not upstream.
