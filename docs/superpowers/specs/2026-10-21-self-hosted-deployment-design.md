# Self-Hosted Deployment — Design

**Date:** 2026-10-21
**Branch:** `feat/self-hosted-deployment` (off `feat/unlimited-syncs`)
**Forks:** `ironwolf-y/graderoom-website`, `ironwolf-y/graderoom-extension`
**School:** Bellarmine (BCP) — the browser extension does the scraping, so the server
needs no Python and no PowerSchool login.

## Goal

Run this fork for about five people, long term, at no cost, without the upstream
project's Google Cloud and OCI accounts.

## What the deployment needs

| Piece | Required? | Why |
|---|---|---|
| Node 22, one long-lived process | yes | Express + Socket.io share one HTTP server |
| MongoDB | yes | All user and grade data |
| Redis | yes | Session store (`connect-redis`) |
| Python + `requests` + `beautifulsoup4` | **no** | Only the server-side scraper uses it, and that is BISV/NDSJ. Bellarmine scrapes in the browser extension. |
| SMTP | no | Only password-reset email. Passwords can be changed from the admin panel. |
| reCAPTCHA Enterprise | **no** | Only `/signup` uses it. Accounts are created directly by a script. |
| The browser extension | yes | It scrapes PowerSchool and hands the data to the page, which uploads it over Socket.io. |

## The one thing that would have sunk this

The extension is pinned to `https://*.graderoom.me/*`, in two different mechanisms:

- **Chrome/Edge** — `externally_connectable.matches`. The page calls
  `chrome.runtime.sendMessage(id, …)` and `chrome.runtime.connect(id)`, which Chrome
  refuses from any origin not in that list. On another domain the extension reads as
  "not installed" and the chip is stuck on **Install**.
- **Firefox** — `content_scripts.matches`. The page↔extension bridge content script is
  never injected, and the chip is stuck on **Sign in needed**.

`debug-manifest.js` already rewrites that pattern for local development, and it walks
the manifest generically, so it handles both manifests at once. The change is to make
the origin a parameter instead of a constant.

The extension never needs to know the server's URL for anything else: it scrapes
PowerSchool, and the page uploads the grades.

## Design

### 1. `REDIS_URL` becomes configurable

`server/graderoom.js` hardcodes the Redis host and derives the port from the HTTP port
(`httpPort + 383`, so 6379 on stable and 6381 on beta). A hosted Redis cannot be
reached that way.

`REDIS_URL` is read from the environment, falling back to the current behaviour, so an
existing local setup keeps working untouched.

### 2. Beta mode becomes explicit

`isBetaServer` is `httpPort !== 5996`. On a PaaS-assigned port that is always true, and
beta mode means two different things: a different Mongo database (`beta` instead of
`stable`), and signup that requires a beta key.

`BETA` in the environment overrides the port: `BETA=true` forces beta, `BETA=false`
forces stable, and leaving it unset keeps the old port-derived behaviour so the
upstream beta deployment on 5998 is unaffected. A port that is missing or not a number
means stable, because beta is the surprising answer and a script with no port
configured would otherwise write to the wrong database.

The port itself is read from `PORT` or `port`, so a host that assigns a port in upper
case works, and `HOST` can narrow the listener to `127.0.0.1` so that a tunnel is the
only way in.

### 3. `.env` is loaded in production too

`dotenv.config()` only runs when `NODE_ENV !== "production"`, so a self-hosted
deployment has to export every variable through the process manager. Loading `.env`
unconditionally is safe — `dotenv` does not overwrite variables that are already set,
so a real environment always wins — and it matches what `.env.example` already tells
people to do.

### 4. Accounts are created by a script

`scripts/create-users.js` reads a JSON file of accounts and calls the same
`dbClient.addUser` the signup route calls, so every validation rule still applies. No
reCAPTCHA, no Google Cloud project, no API key.

The rules the upstream code enforces, which the script reports on rather than
re-implements:
- username: lowercase letters and digits only
- password: 6–64 characters with at least one lowercase, one uppercase and one digit
- Bellarmine email: `first.last##@bcp.org`, e.g. `jane.doe26@bcp.org`

### 5. The extension is patched, not just pointed at

The origin and a pinned Chrome key are both parameters of the manifest patch:

- `GRADEROOM_ORIGIN` replaces `https://*.graderoom.me/*` everywhere it appears.
- `GRADEROOM_EXTENSION_KEY` adds a `key` to the manifest so Chrome's extension ID is
  the same on every machine. Without it, an unpacked extension's ID is a hash of its
  absolute folder path, which differs per user, and the single `TEST_EXTENSION_ID` the
  server can hold would not work for five people.

`scripts/generate-extension-key.js` generates the keypair, writes the public key into
the manifest and prints the extension ID that `TEST_EXTENSION_ID` needs.

Firefox needs no key: its ID is the literal `browser_specific_settings.gecko.id`, and
for an unsigned build it can be anything.

### 6. Hosting

The runbook (`docs/DEPLOYMENT.md`) is written for a machine you control plus a
Cloudflare Tunnel, which is the most reliable free option: no card, no sleep, no idle
reclamation, no bandwidth cap, and a stable HTTPS hostname with no public IP. The
alternative — Oracle Cloud Always Free — is documented in the same file.

## What is deliberately not changed

- The donation tiers, themes and perks. They are part of the app's identity, and the
  sync cooldown is already gone.
- The upstream `CHANGELOG.md` and the mail templates' `graderoom.me` addresses. They
  are cosmetic; the runbook notes which strings are worth replacing in a private
  instance.
- The `beta`/`stable` Mongo database split. It stays; `BETA` just decides which one.
