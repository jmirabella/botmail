# BotMail

BotMail is a Cloudflare Worker that gives each AI bot its own email mailbox. Mail arrives through Cloudflare Email Routing. The Worker stores the raw message in R2 and metadata in D1, wakes the bot with a webhook, and exposes a remote MCP server so that bot can read and send only its own mail. Outbound mail uses the Workers `send_email` binding. An admin dashboard ships in the same Worker, behind Cloudflare Access. OAuth clients, grants, and refresh tokens live in KV. There is no Durable Object. Each MCP request is its own server.

Group settings live in `bot-mail.config.json`. `npm run setup` turns that file into `wrangler.jsonc` and creates the infrastructure. It does not create mailboxes.

## How it works

```
Sender
  |  MX on <your-mail-domain>
  v
Email Routing          one catch-all for the zone
  v
BotMail Worker
  |-- R2    raw .eml and attachments
  |-- D1    mailboxes, messages, routes, domains
  |-- KV    OAuth clients, grants, and refresh tokens
  |
  |-- POST  webhook when mail arrives
  |-- /mcp  https://<your-botmail-host>/mcp
  |         OAuth sign-in, or a static key for scripts
  |
  |-- dashboard  https://<your-admin-host>/
  |              Cloudflare Access
  v
Email Sending from the mailbox address
```

The Worker name and the npm package stay `bot-mail`.

## Quick start

You need:

- Node.js 22 or newer.
- A Cloudflare account on the Workers Paid plan, so Email Sending can reach arbitrary recipients.
- A DNS zone already on that account. Setup looks the zone up. It does not register or delegate a domain.
- A Zero Trust team. Open Zero Trust once in the dashboard. `access.teamDomain` is the team label only, the part before `.cloudflareaccess.com`.
- An API token scoped to this account and this zone. The permission list is in [docs/operations.md](docs/operations.md#api-token).

```sh
cp bot-mail.config.example.jsonc bot-mail.config.json
cp .env.example .env
# Fill both files. The field list is below.
npm install
npm run setup -- --dry-run
npm run setup
```

`bot-mail.config.json` and `.env` are gitignored. `--dry-run` prints the plan and makes no Cloudflare calls. The live command creates the R2 bucket and D1 database if they are missing, builds the dashboard, enables Email Routing and Email Sending, applies migrations, deploys, points the zone catch-all at the Worker, and, when `adminHost` is set, creates the Access application. If that catch-all already sends to a different Worker, setup stops unless you pass `--force-catch-all`. It does not delete routing rules.

When it finishes it prints the MCP URL, the dashboard URL, and `ADMIN_API_KEY` once if it just generated that key. Copy the key into a password manager. Setup also writes `ADMIN_API_KEY` and `DATA_KEY` to `.bot-mail.secrets`. Run `chmod 600 .bot-mail.secrets` and keep a copy offline.

A fresh database has no mailboxes. The only seeded row is the disabled `_unrouted` sink.

## Add a mailbox

Open `https://<your-admin-host>/bots` and choose **New bot**. Pick the domain, the local-part, a display name, and optional notes. The signed-in Access email is stored as the mailbox owner. The page shows a script key once. A remote connector does not use that key.

The same mint from a terminal is `npm run bot:add -- herald --name Herald`. It calls the admin MCP tool `create_bot` and stores the key in `.bot-mail.secrets` without printing it. That path does not set an owner.

Connect the bot with one shared connector:

1. Add a connector named **BotMail**. URL `https://<your-botmail-host>/mcp`. No headers.
2. Add an account named by the mailbox id (the bot id, such as `herald`).
3. Click **Connect**. Sign in through Cloudflare Access on the admin host, then pick that mailbox or create one.

Creating a mailbox on the Connect page records the Access email as the owner and accepts optional notes. Choosing a mailbox that already exists does not change its owner. A mailbox that already has a connection is hidden until an admin revokes it on that bot's page.

To let the bot finish setup itself, fill in the hosts in [`skills/botmail-mailbox-setup/SKILL.md`](skills/botmail-mailbox-setup/SKILL.md) and run that skill in the bot's own chat. **Copy setup prompt** on the bot page is the same sequence for a bot that does not have the skill. The blank text is [`skills/botmail-setup/PROMPT.md`](skills/botmail-setup/PROMPT.md). An operator onboarding several mailboxes can follow [`skills/botmail-setup/SKILL.md`](skills/botmail-setup/SKILL.md).

The Connect page, owner field, and notes are described in [docs/operations.md](docs/operations.md#mailboxes-owner-and-notes).

## Concepts

### Mailboxes

One mailbox is one bot, addressed `<local>@<domain>`, with a stable id. The id is what the connector account is named. Notes (up to 2000 characters) say what the mailbox is for. `owner_email` is a separate field: the Access email recorded at creation, or an address an admin saved later. Migration `0021` adds `owner_email`. Existing rows stay empty until someone sets one.

Archive disables the mailbox and keeps its mail, notes, and address. Nothing in that path deletes a message. Disable and archive clear the API key hash and the webhook ciphertext and revoke the connector. Turning the mailbox back on does not restore those credentials.

### Domains

`mailDomain` in the config is the default domain. It cannot be disabled or removed. More domains are added on the dashboard **Domains** page, without a new deploy. Each mailbox belongs to one domain. Mail for a domain that is missing or disabled is SMTP-rejected.

### Aliases, rename, and forward

An alias is an extra address on one of this install's domains. It delivers a separate copy into each mailbox it targets, and the copy records the alias on `via_alias`. A bot may send with `from` set to an alias that targets its own mailbox. Any other `from` is rejected.

Changing a mailbox address keeps the same id, mail, webhook, and connector. The previous address becomes an alias for that mailbox.

Forward on disable is a setting on the mailbox. While that mailbox is disabled, new inbound mail is stored there and, unless it is junk or quarantine, copied to one other active BotMail mailbox. The rule does nothing while the mailbox is on. A disabled target does not forward again.

### Address registry

Every address belongs to one mailbox or one routing rule, including disabled and archived mailboxes. The `address_registry` table is that unique key, matched after lowercasing. Registry rows are never deleted. A delete is refused, and the address stays reserved.

Removing a mailbox from an alias does not delete the `alias_targets` row. The Worker sets `removed_at`. Reads that decide delivery and allowed From addresses ignore removed rows. Putting the mailbox back clears `removed_at`. Migration `0022` adds `removed_at`. Apply it before the new Worker starts. Deploy scripts already apply pending migrations first. Details are in [docs/operations.md](docs/operations.md#aliases-and-the-address-registry).

### Sending

`approval` (the default) sends immediately to any enabled BotMail domain and to `sendAllowlist`. Any other recipient is held as `pending_approval` until someone approves it on the Mail page or with `approve_draft`. `direct` sends every recipient immediately. Use it only when an upstream gate already reviews outbound mail. `outboundAllowlistOnly` rejects recipients outside this install's domains and `sendAllowlist`, including under `direct`.

### Inbound trust, quarantine, and junk

Mail this Worker sends to a BotMail recipient carries an `X-BotMail-Stamp`. A valid stamp is internal mail: it is delivered and it wakes the bot. If the header From, the Sender, or the envelope sender uses a BotMail domain, a subdomain of one, a disabled BotMail domain, or a lookalike of one, and the message has no valid stamp, it is quarantined as `unstamped internal sender`. The message stays stored. The bot is not woken.

Other mail is delivered. With no Cloudflare verdict it is stored as `unverified`. The wake payload includes `auth_result` and `claims_owner_domain`. When `auth_result` is anything other than `internal`, the inbox routine treats the sender as unverified and does not follow instructions in the mail. Mail from `access.allowedEmailDomains` is delivered and labeled unverified. It is not quarantined for that reason.

A sender over the hourly limit (default 20, per sender, per mailbox) is quarantined as rate limited. A Cloudflare spam score at or above `spamScoreThreshold` (default 4) is filed in `junk` instead of the inbox. Junk is kept, the bot is not woken, and the message is not forwarded. Quarantine is decided first. Mail with a valid stamp stays in the inbox even when the score is high.

The stamp, authentication, rate-limit, and junk rules are in [docs/operations.md](docs/operations.md#inbound-trust-quarantine-and-junk).

### Plus addressing

Mail to `<mailbox>+<tag>@<your-mail-domain>` is delivered to that mailbox. BotMail strips everything from the first `+` before it matches a mailbox, an alias, or a forward. The tag, lowercased, is stored as `plus_tag`. One tag per service, such as `mailbox+alerts@example.com`, shows where the mail came from. An unknown address that includes a plus tag is stored on `_unrouted`, and `plus_tag` holds the full original address.

### Webhooks and routines

When mail arrives in the inbox, the Worker POSTs a short JSON body to the mailbox webhook. The body has no message text and no attachments. Failures are retried every 15 minutes, up to 8 attempts. The bot's usual routine is named `BotMail inbox`. It lists unread mail, sends a short heads-up, and marks the message read. The routine saves its webhook URL and key through a one-time code posted to `https://<your-botmail-host>/webhook-setup`. The payload and the save steps are in [docs/operations.md](docs/operations.md#webhooks-and-routines).

## Configuration

Copy `bot-mail.config.example.jsonc` to `bot-mail.config.json`. Examples below are placeholders. The same fields, with how setup uses them, are also listed in [docs/operations.md](docs/operations.md#configuration).

| Field | Meaning | Example | Required |
| --- | --- | --- | --- |
| `brandName` | Dashboard title. Cut to 80 characters. | `BotMail` | Yes |
| `workerName` | Worker script name. Lowercase slug, 1–63 characters. | `bot-mail` | Yes |
| `mailZone` | DNS zone already on this account. | `example.email` | Yes |
| `mailDomain` | Default mailbox domain. The zone, or a subdomain of it. | `bot.example.email` | Yes |
| `r2Bucket` | R2 bucket name. | `bot-mail` | Yes |
| `d1Name` | D1 database name. | `bot-mail` | Yes |
| `sendPolicy` | `approval` holds outside recipients. `direct` sends immediately and needs an upstream review gate. | `approval` | No. Default `approval` |
| `sendAllowlist` | Extra recipient emails or domains that send immediately under `approval`. With `outboundAllowlistOnly`, this list is the only way out of your mail domains. | `[]` | Key required. Array may be empty |
| `routing` | `catch-all` (default) writes the zone catch-all. `literal` never writes it, and creates one rule per mailbox instead. | `catch-all` | No |
| `outboundAllowlistOnly` | `true` rejects recipients that are outside this install's domains and `sendAllowlist`, including under `direct`. | `false` | No |
| `inboundRateLimit` | Messages one sender may deliver to one mailbox per hour. Integer from 1 to 1000. | `20` | No. Default `20` |
| `spamScoreThreshold` | `X-Cf-Spamh-Score` at or above this integer (1–5) goes to Junk. `off` stores the score and leaves the message in the inbox. | `4` | No. Default `4` |
| `inboundBotRateLimit` | Stamped messages one sender may deliver to one mailbox per hour. Integer from 1 to 1000. | `30` | No. Default `30` |
| `inboundAutoReplyLimit` | Bot sends one mailbox may make to one BotMail recipient in the window. Integer from 1 to 1000. | `20` | No. Default `20` |
| `inboundAutoReplyWindow` | Window for that limit, in seconds. Integer from 60 to 604800. | `3600` | No. Default `3600` |
| `outboundDailyStampLimit` | Stamped BotMail recipients one bot may send in a day, including dashboard approvals. Integer from 1 to 10000. | `200` | No. Default `200` |
| `uniqueBotNames` | `true` allows a local-part on one domain only. | `true` | No. Default `true` |
| `adminHost` | Dashboard hostname. Empty skips Access, and the dashboard is not served. | `mail-admin.example.email` | Required for a dashboard |
| `publicHost` | Hostname bots use for `/mcp`. Not `adminHost`. A `*.workers.dev` name forces `workers_dev` on. | `<your-botmail-host>` | Set it before bots connect |
| `workersDev` | Keep the workers.dev hostname. | `true` | No. Default `true` |
| `access.teamDomain` | Access team label. | `your-team` | Required for the dashboard lock |
| `access.aud` | Leave empty. Setup stores the application audience. | `""` | No |
| `access.allowedEmailDomains` | Email domains that may open the dashboard. | `["example.com"]` | Required when `adminHost` is set |
| `branding.logo` | Logo URL. Empty or `https://`. | `""` | No |
| `branding.accent` | Accent color. | `#7aa2ff` | No. Default `#7aa2ff` |

`.env`, from `.env.example`:

| Variable | Meaning | Required |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Deploy token. Not sent to the browser. | Yes, for a live run |
| `CLOUDFLARE_ACCOUNT_ID` | Account that owns the zone. | Yes, for a live run |
| `ADMIN_API_KEY` | Admin MCP bearer. Empty: setup generates one and prints it once. | No |
| `DATA_KEY` | Encrypts webhook keys, signs attachment links, and stamps mail this Worker sends. The stamp key is derived with HKDF and info `botmail-stamp-v1`. Empty: setup generates one. It is not printed. No separate stamp secret. | No |
| `CLOUDFLARE_DOMAINS_API_TOKEN` | Narrower token for the Domains page. See [docs/operations.md](docs/operations.md#domains-api-token). | No |

A leftover `bots` array in the config is ignored. Add mailboxes on the dashboard.

## Dashboard

The dashboard is `https://<your-admin-host>/`. `/` redirects to `/mail`. Pages: `/mail`, `/bots`, `/bots/<id>`, `/routing`, `/domains`, `/health`, `/settings`.

Cloudflare Access is the only lock. The Worker checks `Cf-Access-Jwt-Assertion` (team, audience, expiry, signature, and email domain) on every page and every `/admin/api` call. There is no key prompt. The admin API key is not accepted on this host. It works only for admin MCP tools and scripts on `https://<your-botmail-host>/mcp`.

If `adminHost` is empty, the dashboard is not served. If the Access team or audience is missing, every page says Access is not configured. Mutating `/admin/api` calls also send `X-Bot-Mail-Action: 1`.

| Page | What it is for |
| --- | --- |
| Mail | Inbox, junk, quarantine, sent, search, approval queue, attachments |
| Bots | Create a mailbox, copy its address, read notes |
| Bot detail | Owner, notes, setup prompt, connector, webhook, test wake, archive |
| Routing | Aliases into one or more mailboxes, external forwards, unknown-recipient policy |
| Domains | Add a domain, recheck DNS, enable or disable it |
| Health | Counts, webhook retries, attachment backfill |
| Settings | Send policy, sender checks, junk threshold, rate limit, allow and block lists |

## Operations

`npm run deploy` builds the dashboard, rewrites `wrangler.jsonc` from `bot-mail.config.json` and `bot-mail.state.json`, applies pending remote D1 migrations, then deploys the Worker. `npm run setup` does that work and also creates resources and routing. What each step changes is in [docs/operations.md](docs/operations.md#what-setup-does).

### Staging

Staging is a second install. It uses `bot-mail.staging.json`, which ships with placeholders (`example.email`, Access team `your-team`, operator domain `example.com`). Replace those with your zone, hosts, and Access team before a live run. Commit only placeholder hostnames. State and secrets go to `bot-mail.staging.state.json` and `.bot-mail.staging.secrets`, both gitignored. `npm run setup` and `npm run deploy` still read `bot-mail.config.json`.

The staging file sets `routing` to `literal` and `outboundAllowlistOnly` to `true`, with its own Worker, D1, R2, and Access host. Literal mode leaves the zone catch-all alone and creates one routing rule per mailbox, so this install does not take another install's mail. Outbound mail is limited to this install's domains plus `sendAllowlist`. Other recipients are rejected. The Settings allowlist does not widen that.

One manual step. In the Cloudflare dashboard open **Email Routing** for the zone, then **Settings → Subdomains**, and enable the `mailDomain` label (`staging` when `mailDomain` is `staging.example.email`). Setup cannot create a subdomain catch-all. Catch-all rules exist only for the apex.

```sh
npm run setup:staging -- --dry-run
npm run setup:staging
npm run deploy:staging
npm run route:staging -- herald
BOT_MAIL_CONFIG=bot-mail.staging.json npm run bot:add -- herald --name Herald
```

`setup:staging`, `deploy:staging`, and `route:staging` read `bot-mail.staging.json` by that name. `deploy:staging` applies that install's remote D1 migrations, then deploys. It does not call the routing API. `route:staging` adds or updates the rule for one address and does not deploy. Do not pass `--force-catch-all` on the staging config. Routing details are in [docs/operations.md](docs/operations.md#staging).

### Migrations

Every file in `migrations/` is additive: new tables, columns, and indexes, plus a few updates that clear credentials on mailboxes that were already disabled or archived. They do not delete mail or raw `.eml` objects. `npm run setup`, `npm run deploy`, and `npm run deploy:staging` apply pending remote D1 migrations before the Worker starts. The current Worker reads columns through `0022`, including `owner_email` and `removed_at`, so those migrations have to be applied first. The list of what each migration adds is in [docs/operations.md](docs/operations.md#migrations).

### Upgrading

From the repo root, with the existing `wrangler.jsonc` still on disk:

```sh
git pull
npm install
npx wrangler d1 time-travel info <d1-name> --timestamp <utc-time>
npm run setup
```

Use the current UTC time and save the bookmark the command prints. A rerun updates the Worker, applies migrations, and rewrites config vars. It does not insert, update, or delete mailboxes, keys, webhooks, routes, notes, or mail. It does not rotate `ADMIN_API_KEY` or `DATA_KEY` when those secrets are already on the Worker. Secret rotation and Time Travel are in [docs/operations.md](docs/operations.md#upgrading).

### Troubleshooting

| Symptom | What to do |
| --- | --- |
| Setup exits and names the Node version. | Install Node.js 22 or newer, then run `npm run setup` again. |
| A Cloudflare call returns 401, 403, or error 10000. | The API token is missing, expired, or missing a permission. Recreate it with the list in [docs/operations.md](docs/operations.md#api-token), scoped to this account and this zone. |
| The dashboard has no Access sign-in, or every page says Access required. | Add **Access: Apps and Policies Edit** and **Access: Organizations Read**, set `adminHost`, `access.teamDomain`, and `access.allowedEmailDomains`, and run setup again. Sign in with an allowed email. |
| The dashboard returns 401 after Access sign-in. | `CF_ACCESS_AUD` was empty. Setup stores the audience as `accessAud` in the state file. Deploy reads that value (or `access.aud` in the group config) and refuses to publish a Worker without it. |
| `https://<your-botmail-host>/mcp` returns Error 1042. | `publicHost` is not a `*.workers.dev` name and `workersDev` is false, so the workers.dev hostname was turned off. Set `publicHost` to `<worker>.<account-subdomain>.workers.dev` and run setup again. |
| The connector is rejected, or the wake uses the wrong credential. | Use the shared BotMail connector at `https://<your-botmail-host>/mcp` with no headers. The account name is the mailbox id. Save the Routine Webhook key from the bot's shell. Do not paste it into the connector, and do not pass a masked secret into an MCP tool argument. |
| A setup link opens the wrong field. | Copy the Webhook URL and Webhook key links from the latest status reminder. If that reminder has no field links yet, build both from the folder id in the routine save result (`folder <id>`). |
| Mail arrives and the bot does not wake. | On the bot page, URL set and Key set both need to be Yes. Press **Send test wake**. The setup code expires in 10 minutes, works once, and the POST is rate-limited. |
| A send stays `pending_approval`. | `sendPolicy` is `approval`. Recipients on your mail domains or `sendAllowlist` send immediately. Approve the rest on the Mail page. Use `direct` only when an upstream gate already reviews outbound mail. |
| Message reads fail after a deploy. | Pending D1 migrations were not applied. `npm run deploy` applies them before the Worker. If you deployed another way, run `npm run db:migrate:remote` before the new Worker starts. |

Longer causes, token permissions, secrets, and recovery are in [docs/operations.md](docs/operations.md).

## Where to look next

- [docs/operations.md](docs/operations.md) — setup, routing, mailboxes, aliases, inbound checks, webhooks, secrets, migrations, and recovery.
- [`skills/botmail-mailbox-setup/SKILL.md`](skills/botmail-mailbox-setup/SKILL.md) — one bot connecting its own mailbox.
- [`skills/botmail-setup/SKILL.md`](skills/botmail-setup/SKILL.md) — an operator onboarding one or many mailboxes.
- [`skills/botmail-setup/PROMPT.md`](skills/botmail-setup/PROMPT.md) — the paste-ready setup message.

## License

Licensed under the [MIT License](LICENSE).
