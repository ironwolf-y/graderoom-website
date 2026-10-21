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
| MongoDB | yes | All user and grade data. Atlas M0 is free forever at 512 MB |
| Redis | yes | Session store. Local `redis-server` or the Upstash free tier |
| A browser extension build | yes | Only for Bellarmine. See [the extension](#the-extension) |
| Python 3 + three packages | optional | Only to seed the class catalogue. See [the catalogue](#optional-the-class-catalogue) |
| SMTP | optional | Only for password reset by email. A forgotten password can be reset from the shell instead |
| reCAPTCHA | no | Only the signup page uses it. Accounts are created by a script |

**Before you start, you need a domain** in a Cloudflare zone. The tunnel gives your
instance a hostname, and the browser extension has to be built for that exact
hostname, so pick it now and do not change it later.

---

## Pick a host

**A machine you control (recommended).** No card, no sleep, no idle reclamation, no
bandwidth cap, and the database sits on a disk you can back up. A spare PC, a NAS, or
a Raspberry Pi 5 is plenty for five people.

**Oracle Cloud Always Free.** One A1 instance (2 OCPU, 12 GB) running Node, MongoDB and
Redis. A card and phone number are required, and **idle instances get reclaimed after
seven days under 20% use** — you get an email first, and a stopped instance keeps its
disk, so it is recoverable but it is an outage.

**Render, or any free container host.** It works — the server reads `PORT` as well as
`port` — but it is a preview tier: the instance spins down after fifteen minutes
without traffic, including WebSocket messages, so the first person to arrive waits
about a minute for it to wake up. Outbound SMTP is blocked, so a forgotten password has
to be reset from a shell, which a free container does not give you easily. Set
`BETA=false` so the assigned port does not put it into beta mode.

---

## Install on a machine you control

### 1. The basics

```bash
sudo apt update
sudo apt install -y nodejs npm redis-server curl gnupg
```

Node 22 or newer is needed. On Debian and Ubuntu the distribution's node is usually too
old, so use [NodeSource](https://github.com/nodesource/distributions) if
`node --version` says anything below 22.

MongoDB is not in the Debian or Ubuntu repositories, so it needs its own repository.
Check `lsb_release -cs` for your codename (jammy, noble, bookworm):

```bash
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu $(lsb_release -cs)/mongodb-org/8.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list
sudo apt update
sudo apt install -y mongodb-org
```

That line is for Ubuntu. On Debian, replace `ubuntu` with `debian` in the repository
URL. MongoDB 5.0 and newer need a CPU with AVX support; on an older machine use
[MongoDB Atlas M0](https://www.mongodb.com/atlas) instead and skip this step.

### 2. The code

```bash
sudo useradd --system --user-group --home /opt/graderoom --shell /usr/sbin/nologin graderoom
sudo git clone --branch feat/self-hosted-deployment https://github.com/ironwolf-y/graderoom-website.git /opt/graderoom
sudo chown -R graderoom:graderoom /opt/graderoom
cd /opt/graderoom
sudo -u graderoom npm ci --omit=dev
```

The branch is named because the pull request has not been merged into the fork's
`master` yet. Once it has, you can drop `--branch`.

### 3. Configure

```bash
sudo install -m 600 -o root -g graderoom deploy/graderoom.env.example /etc/graderoom.env
sudo nano /etc/graderoom.env
```

At minimum, set:

```ini
port=5996
BETA=false
HOST=127.0.0.1
SECRET=<a long random string>
DB_URL=mongodb://127.0.0.1:27017
```

`SECRET` signs the session cookies. `openssl rand -base64 48` makes a good one.
Changing it later logs everyone out. The file holds it, so it is readable only by root
and the graderoom group.

`BETA=false` matters: without it the port alone decides the mode, and a host that
assigns a port would land in beta mode, which uses a different database and needs a
beta key to sign up.

`HOST=127.0.0.1` means the Cloudflare Tunnel is the only way in. Leave it empty to
listen on every interface, which is what the upstream server does.

This file is systemd's `EnvironmentFile`. The server also reads a `.env` file in its
working directory if there is one, and a real environment variable always wins over
either, so you can keep the two apart if you prefer.

### 4. Run it

```bash
sudo cp deploy/graderoom.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now graderoom
sudo systemctl status graderoom
journalctl -u graderoom -f
```

The first start creates the `stable` database and an account with the username
`admin` and the password `Pa5sw0rd`. **Change it immediately** from the admin panel.

**After any edit to `/etc/graderoom.env`, restart the service** — systemd reads that
file only when it starts:

```bash
sudo systemctl restart graderoom
```

---

## Give it an address

A Cloudflare Tunnel gives a stable HTTPS hostname with no public IP and no open ports
on your router. It is free and needs no card.

```bash
# Install cloudflared from Cloudflare's own repository
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update
sudo apt install -y cloudflared

# Create the tunnel and point it at your hostname
cloudflared tunnel login
cloudflared tunnel create graderoom
cloudflared tunnel route dns graderoom grades.example.com
```

`cloudflared tunnel create` writes its credentials to `~/.cloudflared/<tunnel-id>.json`.
The service runs as the `cloudflared-user` account and cannot read your home
directory, so move the credentials and the config into place:

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<tunnel-id>.json /etc/cloudflared/
sudo cp deploy/cloudflared-config.yml.example /etc/cloudflared/config.yml
sudo nano /etc/cloudflared/config.yml   # put your tunnel id and hostname in it
sudo chown -R cloudflared-user:cloudflared-user /etc/cloudflared
sudo cloudflared --config /etc/cloudflared/config.yml service install
sudo systemctl enable --now cloudflared
```

The hostname you chose here is the one the browser extension has to be built for.

---

## The extension

The published extension is pinned to `https://*.graderoom.me/*`, so a page served from
anywhere else cannot talk to it. Chrome's `externally_connectable` refuses the page's
messages, and Firefox never injects the bridge content script. You need your own
build.

```bash
git clone --branch feat/self-hosted-instance https://github.com/ironwolf-y/graderoom-extension.git
cd graderoom-extension

# Pin the Chrome extension ID so every user gets the same one
node scripts/generate-extension-key.js chrome/manifest.json

# Point the manifest at your instance. The pattern needs a path, so it ends in /*
GRADEROOM_ORIGIN=https://grades.example.com/* \
GRADEROOM_EXTENSION_NAME="Graderoom (Private)" \
  node debug-manifest.js chrome/manifest.json
```

The first command prints an extension id. Put it in `/etc/graderoom.env`:

```ini
TEST_EXTENSION_ID=<the id that was printed>
```

Then restart the server, because systemd only reads the environment file at start:

```bash
sudo systemctl restart graderoom
```

Without the `key` the manifest gets, an unpacked extension's ID is a hash of its
install path, so it differs on every machine and one `TEST_EXTENSION_ID` would only
work for one person.

### Handing it to your five users

**Build it once and give everyone the same folder.** Do not ask them to run the key
generator: a second key means a second ID, and the server only knows one. Zip the
patched `chrome` folder and send it to each of them.

- **Chrome and Edge:** unzip the folder, open `chrome://extensions`, turn on Developer
  mode, "Load unpacked", pick the folder.
- **Firefox:** open `about:debugging#/runtime/this-firefox`, "Load Temporary Add-on",
  pick `firefox/manifest.json`. Firefox keeps its own extension id, so nothing else is
  needed for it — but a temporary add-on is removed when Firefox closes, so each of
  them has to load it again after a restart. For a long-lived install, sign the
  extension yourself and distribute the signed package.

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
sudo install -m 600 -o root /dev/null /root/accounts.json
sudo nano /root/accounts.json
cd /opt/graderoom
sudo -u graderoom DB_URL=mongodb://127.0.0.1:27017 node scripts/create-users.js /root/accounts.json
sudo rm /root/accounts.json
```

The file holds passwords, so keep it readable only by root and delete it afterwards.
`password` may be left out, in which case the script asks for one without echoing it.
The rules are the same ones the signup page enforces: a lowercase letters-and-digits
username of at most 16 characters, a password of 6 to 64 characters with a lowercase, an
uppercase and a digit, and a school email of the right shape (`first.last##@bcp.org`
for Bellarmine). Anything the server refuses is reported with the reason.

Re-running the script is safe. An account that already exists is reported and the rest
still get created.

### If someone forgets their password

Without SMTP there is no reset email, so reset it from the shell:

```bash
cd /opt/graderoom
sudo -u graderoom DB_URL=mongodb://127.0.0.1:27017 node scripts/set-password.js jdoe
```

It asks for the new password without echoing it. This needs shell access to the box,
which is why there is no route that reaches it.

---

## Optional: the class catalogue

The `common` database holds the Bellarmine course catalogue, which is what the class
average and teacher features read. It is seeded from the public BCP catalogue. Without
it the instance still works — your own grades, GPA and charts are all in your own
account — but there are no class averages and no teacher names.

This is the one part that needs Python:

```bash
sudo apt install -y python3-pip
sudo pip install --break-system-packages -r /opt/graderoom/requirements.txt
cd /opt/graderoom
sudo -u graderoom DB_URL=mongodb://127.0.0.1:27017 python3 server/catalog_to_json.py --mongo
```

The `--mongo` argument is what makes it write to the database; without it the script
only fetches the catalogue page. It also rewrites `catalog.html` in the working
directory, which the repository tracks, so `git pull` may refuse to update later.
Either add it to `.git/info/exclude` or restore it before upgrading.

---

## Back it up

Grades are the only thing here worth losing sleep over, and a free-tier host can be
reclaimed out from under you.

```bash
sudo cp /opt/graderoom/deploy/backup-mongo.sh /usr/local/bin/
sudo chmod 700 /usr/local/bin/backup-mongo.sh
sudo crontab -e
```

Add this line to the crontab, without the `#`:

```
17 4 * * * /usr/local/bin/backup-mongo.sh
```

The script reads `/etc/graderoom.env` itself, so the dump always points at the
database the server is using. It keeps fourteen days of archives in
`/var/backups/graderoom`, readable only by the owner, and fails loudly rather than
leaving you with an empty archive.

Copy them somewhere else. A backup on the same disk as the database is not a backup.

---

## Worth changing in a private instance

None of this breaks anything, but it reads oddly for a private group.

| Where | What |
|---|---|
| `server/emailSender.js` | The sender is `no-reply@graderoom.me`, the unsubscribe link points at `graderoom.me`, and the email image is loaded from `graderoom.me`. Change the host to yours, or leave the mail settings blank and use `scripts/set-password.js` instead. |
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

If `git pull` refuses because of `catalog.html`, see the catalogue section above.
Schema changes migrate themselves on start, and a failed migration leaves the user
pending rather than half-migrated, so it retries on the next boot.

---

## When something goes wrong

**The chip says the extension is not installed.** The page cannot reach the extension.
Check that the manifest's origin matches your hostname exactly, that it ends in `/*`,
and that `TEST_EXTENSION_ID` matches the id `scripts/generate-extension-key.js`
printed. A Chrome extension installed before the key was added has a different id, so
uninstall and reinstall it. After changing `TEST_EXTENSION_ID`, restart the service.

**Users get logged out constantly.** Redis is not persisting. Check that `REDIS_URL`
points at a Redis that is actually running, and that it has a disk. The free Upstash
tier is fine; a Redis that restarts without a disk loses every session.

**The sign-up page asks for a beta key.** The server is in beta mode. Set
`BETA=false` in `/etc/graderoom.env` and restart.

**The server will not start and the log says the port is bad.** `port` is not set, or
is not a number. Check `/etc/graderoom.env`.

**Grades do not appear after a sync.** Check the browser console and the server log.
The extension holds the PowerSchool session, so a sync that reports "not logged in"
means the extension needs to sign in to PowerSchool again.

**Running the test suite.** It needs a MongoDB it can write to, and it connects to
`mongodb://127.0.0.1:27017` — the URL is fixed in the `test` script, so `DB_URL` does
not redirect it:

```bash
cd /opt/graderoom
npm test
```

**A note on what is exposed.** With `HOST=127.0.0.1` the server is only reachable
through the tunnel, but MongoDB and Redis on the same box are unauthenticated by
default and listen on every interface. On a shared host, bind them to 127.0.0.1 in
their own configuration files, or firewall those ports.
