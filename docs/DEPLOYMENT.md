# Running your own Graderoom

This fork is set up for a private instance for a handful of people. It has no tier
cooldown on syncing — every account syncs on the same one minute floor — and it needs
no Google Cloud project, no OCI email account and no Python.

Everything below assumes the free path: a machine you control, a Cloudflare Tunnel
for a stable HTTPS address, and MongoDB and Redis running on the same box.

---

## What you need

| Piece | Needed | Notes |
|---|---|---|
| Node 22+ | yes | The server is Express + Socket.io on one port |
| MongoDB | yes | All user and grade data. `MongoDB Atlas` M0 is free forever at 512 MB |
| Redis | yes | Session store. Local `redis-server` or `Upstash` free tier |
| A browser extension build | yes | Only for Bellarmine. See [the extension](#the-extension) |
| Python | no | Only the server-side scraper uses it, and that is BISV/NDSJ |
| SMTP | no | Only for password reset by email |
| reCAPTCHA | no | Only the signup page uses it. Accounts are created by a script |

---

## Pick a host

**A machine you control (recommended).** No card, no sleep, no idle reclamation, no
bandwidth cap, and the database sits on a disk you can back up. A spare PC, a NAS, or
a Raspberry Pi 5 is plenty for five people.

**Oracle Cloud Always Free.** One A1 instance (2 OCPU, 12 GB) running Node, MongoDB and
Redis. A card and phone number are required, and **idle instances get reclaimed after
seven days under 20% use** — you get an email first, and a stopped instance keeps its
disk, so it is recoverable but it is an outage.

**Render, or any free container host.** Works, but it is a preview tier: the instance
spins down after fifteen minutes without traffic, including WebSocket messages, so the
first person to arrive waits about a minute for it to wake up. Outbound SMTP is blocked
too. Set `BETA=false` so the assigned port does not put it into beta mode.

---

## Install on a machine you control

### 1. The basics

```bash
sudo apt update
sudo apt install -y nodejs npm mongodb-org redis-server python3-pip
```

Node 22 or newer is needed. On Debian and Ubuntu the distribution's node is often too
old; use [NodeSource](https://github.com/nodesource/distributions) if `node --version`
says something below 22.

### 2. The code

```bash
sudo useradd --system --home /opt/graderoom --shell /usr/sbin/nologin graderoom
sudo git clone https://github.com/ironwolf-y/graderoom-website.git /opt/graderoom
sudo chown -R graderoom:graderoom /opt/graderoom
cd /opt/graderoom
sudo -u graderoom npm ci --omit=dev
```

### 3. Configure

```bash
sudo cp deploy/graderoom.env.example /etc/graderoom.env
sudo nano /etc/graderoom.env
```

At minimum, set:

```ini
port=5996
BETA=false
SECRET=<a long random string>
DB_URL=mongodb://127.0.0.1:27017
```

`SECRET` signs the session cookies. `openssl rand -base64 48` makes a good one.
Changing it later logs everyone out.

`BETA=false` matters: without it, the port alone decides the mode, and a host that
assigns a port would land in beta mode, which uses a different database and needs a
beta key to sign up.

The `.env` file is read in production too, and a real environment variable always
wins over the file, so a systemd unit with its own variables still overrides it.

### 4. Run it

```bash
sudo cp deploy/graderoom.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now graderoom
sudo systemctl status graderoom
journalctl -u graderoom -f
```

The first start creates the `stable` database and an `admin` account with the password
`Pa5sw0rd`. **Change it immediately** from the admin panel.

---

## Give it an address

A Cloudflare Tunnel gives a stable HTTPS hostname with no public IP and no open ports
on your router. It is free and needs no card.

```bash
cloudflared tunnel login
cloudflared tunnel create graderoom
cloudflared tunnel route dns graderoom grades.example.com
```

Then copy `deploy/cloudflared-config.yml.example` to
`/etc/cloudflared/config.yml`, fill in the tunnel id and your hostname, and install
`cloudflared` as a service:

```bash
sudo cloudflared --config /etc/cloudflared/config.yml service install
sudo systemctl enable --now cloudflared
```

The hostname you chose here is the one the browser extension has to be built for.

---

## The extension

The published extension is pinned to `https://*.graderoom.me/*`, so a page served from
anywhere else cannot talk to it. Chrome's `externally_connectable` refuses the page's
messages, and Firefox never injects the bridge content script. You need your own build.

```bash
git clone https://github.com/ironwolf-y/graderoom-extension.git
cd graderoom-extension

# Pin the Chrome extension ID so every user gets the same one
node scripts/generate-extension-key.js chrome/manifest.json

# Point the manifest at your instance
GRADEROOM_ORIGIN=https://grades.example.com \
GRADEROOM_EXTENSION_NAME="Graderoom (Private)" \
  node debug-manifest.js chrome/manifest.json
```

The first command prints an extension id. Put it in `/etc/graderoom.env`:

```ini
TEST_EXTENSION_ID=<the id that was printed>
```

Without the `key` the manifest gets, an unpacked extension's ID is a hash of its
install path, so it differs on every machine and one `TEST_EXTENSION_ID` would only
work for one person.

**Handing it to your five users.** Chrome and Edge: open `chrome://extensions`, turn
on Developer mode, "Load unpacked", pick the `chrome` folder. Firefox: open
`about:debugging#/runtime/this-firefox`, "Load Temporary Add-on", pick
`firefox/manifest.json`. Firefox keeps its own extension id, so nothing else is
needed for it.

The extension is unpacked, so it is not auto-updated. When you change it, your users
reload it from the same folder.

---

## Create the accounts

The signup page needs reCAPTCHA Enterprise, which needs a Google Cloud project. You do
not need any of that — accounts go straight into the database:

```json
[
  {"school": "bellarmine", "username": "jdoe", "password": "Passw0rd", "schoolEmail": "jane.doe26@bcp.org"},
  {"school": "bellarmine", "username": "rsmith", "password": "Passw0rd", "schoolEmail": "bob.smith26@bcp.org"}
]
```

```bash
cd /opt/graderoom
sudo -u graderoom DB_URL=mongodb://127.0.0.1:27017 node scripts/create-users.js accounts.json
```

`password` may be left out, in which case the script asks for it. The rules are the
same ones the signup page enforces: a lowercase letters-and-digits username, a
password of 6 to 64 characters with a lowercase, an uppercase and a digit, and a
school email of the right shape (`first.last##@bcp.org` for Bellarmine).

Re-running the script is safe. An account that already exists is reported and the rest
still get created.

### Optional: the class catalogue

The `common` database holds the Bellarmine course catalogue, which is what the class
average and teacher features read. It is seeded from the public BCP catalogue:

```bash
cd /opt/graderoom
sudo -u graderoom DB_URL=mongodb://127.0.0.1:27017 python3 server/catalog_to_json.py
```

Without it the instance still works — your own grades, GPA and charts are all in your
own account — but there are no class averages and no teacher names.

---

## Back it up

Grades are the only thing here worth losing sleep over, and a free-tier host can be
reclaimed out from under you.

```bash
sudo cp /opt/graderoom/deploy/backup-mongo.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/backup-mongo.sh
sudo crontab -e
# 17 4 * * * BACKUP_DIR=/var/backups/graderoom /usr/local/bin/backup-mongo.sh
```

It keeps fourteen days of `mongodump` archives in `/var/backups/graderoom`. Copy them
somewhere else, because a backup on the same disk as the database is not a backup.

---

## Worth changing in a private instance

None of this breaks anything, but it reads oddly for a private group.

| Where | What |
|---|---|
| `server/emailSender.js` | The sender is `no-reply@graderoom.me`, the unsubscribe link points at `graderoom.me`, and the email image is loaded from `graderoom.me`. Change the host to yours, or leave the mail settings blank and change passwords from the admin panel instead. |
| `server/dbClient.js`, `server/passport.js`, `server/routes.js` | "Archived account" and password-reset messages say to email `support@graderoom.me`. Point them at whoever is actually running the instance. |
| `views/partials/user/privacy_policy.ejs`, `views/viewer/privacy_policy.ejs` | The privacy policy and terms mention graderoom.me. A private instance is not the upstream service, so rewrite them for your group. |

---

## Upgrading

```bash
cd /opt/graderoom
sudo -u graderoom git pull
sudo -u graderoom npm ci --omit=dev
sudo systemctl restart graderoom
```

Schema changes migrate themselves on start, and a failed migration leaves the user
pending rather than half-migrated, so it retries on the next boot.

---

## When something goes wrong

**The chip says the extension is not installed.** The page cannot reach the extension.
Check that the manifest's origin matches your hostname exactly, and that
`TEST_EXTENSION_ID` in `/etc/graderoom.env` matches the id
`scripts/generate-extension-key.js` printed. A Chrome extension that was installed
before the key was added has a different id, so uninstall and reinstall it.

**Users get logged out constantly.** Redis is not persisting. Check that `REDIS_URL`
points at a Redis that is actually running, and that it has a disk. The free Upstash
tier is fine; a Redis that restarts without a disk loses every session.

**The sign-up page asks for a beta key.** The server is in beta mode. Set
`BETA=false` in `/etc/graderoom.env` and restart.

**Grades do not appear after a sync.** Check the browser console and the server log.
The extension holds the PowerSchool session, so a sync that reports "not logged in"
means the extension needs to sign in to PowerSchool again.

**`npm test` cannot connect.** The suite needs MongoDB. On a machine with one running:
`npm test`.
