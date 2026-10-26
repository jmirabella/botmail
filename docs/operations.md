# Operations

This is the long path behind [the README](../README.md): what setup changes, how mail is routed, and how to run an install. Examples use `example.email`, `<your-botmail-host>`, `<your-admin-host>`, `<your-mail-domain>`, and `<your-team>`. Put your own zone, hosts, and mail domain in `bot-mail.config.json`.

## API token

Create a custom token scoped to this one account and this one zone. The dashboard labels a group Edit or Write. Those are the same permission. Names match the [Cloudflare permissions catalog](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).

Account:

- **Workers Scripts Edit** (also labeled Workers Scripts Write).
- **D1 Edit**.
- **Workers R2 Storage Edit**.
- **Email Sending Edit**, when the token UI offers it. Email Sending is not a row in every catalog. Setup calls `POST /zones/{zone_id}/email/sending/subdomains`. A 403 prints the dashboard onboard step and setup continues. Sending to arbitrary recipients needs the Workers Paid plan.
- **Email Routing Addresses Edit**. Include it. Setup does not call the addresses API and does not put `addresses` in `wrangler.jsonc`.
- **Access: Apps and Policies Edit** and **Access: Organizations Read**, when `adminHost` is set. A 403 means no Access application was created. The Worker still returns 401 and does not render the dashboard until the team, audience, and a valid JWT are present.

Zone (`mailZone` only):

- **Zone Read**.
- **DNS Edit** (also labeled DNS Write).
- **Zone Settings Edit**. Routing DNS accepts Zone Settings Read or Zone Settings Write.
- **Email Routing Rules Edit**. Setup writes the catch-all with this permission.

Optional, and not required for setup. Adding them removes two Wrangler warnings:

- **User Details Read**.
- **Memberships Read**.

Put the token in `CLOUDFLARE_API_TOKEN` and the account id in `CLOUDFLARE_ACCOUNT_ID`.

### Domains API token

Without `CF_API_TOKEN`, the Domains page still records a domain and still checks DNS, and it lists the dashboard steps. A dedicated token lets the Worker enable routing, set the catch-all, and onboard sending for domains you add later. Give it, per zone:

- **Zone Read**
- **Zone Settings Edit**
- **Email Routing Rules Edit**
- **Email Sending Edit**, if the token UI offers it

Put it in `CLOUDFLARE_DOMAINS_API_TOKEN` and run `npm run setup` again. Setup uploads it when the Worker secret is missing. `npm run setup -- --share-deploy-token` stores the deploy token instead. The value stays a Worker secret. The browser only learns whether one exists. To replace it by hand: `npx wrangler secret put CF_API_TOKEN`.

A dedicated token is safer. The deploy token can also edit Workers, D1, R2, and Access.

## Configuration

Copy `bot-mail.config.example.jsonc` to `bot-mail.config.json`. Nothing in that file is compiled into the Worker. `npm run setup` and `npm run deploy` read it. A second install uses `bot-mail.staging.json`. See [Staging](#staging).

| Field | Meaning |
| --- | --- |
| `brandName` | Dashboard title. Cut to 80 characters. |
| `workerName` | Worker script name. Lowercase slug, 1–63 characters. |
| `mailZone` | DNS zone already on this account. |
| `mailDomain` | Default mailbox domain. The zone, or a subdomain of it. |
| `r2Bucket`, `d1Name` | R2 bucket and D1 database names. Lowercase slugs. |
| `sendPolicy` | `approval` (default) or `direct`. |
| `sendAllowlist` | Emails or domains that send immediately under `approval`. The key is required. The array may be empty. |
| `routing` | `catch-all` (default) or `literal`. |
| `outboundAllowlistOnly` | When `true`, recipients outside this install's domains and `sendAllowlist` are rejected, including under `direct`. |
| `inboundRateLimit` | Messages one sender may deliver to one mailbox per hour. Integer 1–1000. Default 20. |
| `spamScoreThreshold` | Integer 1–5, or `off`. Default 4. |
| `inboundBotRateLimit` | Stamped messages one sender may deliver to one mailbox per hour. Integer 1–1000. Default 30. |
| `inboundAutoReplyLimit` | Bot sends one mailbox may make to one BotMail recipient in the window. Integer 1–1000. Default 20. |
| `inboundAutoReplyWindow` | That window, in seconds. Integer 60–604800. Default 3600. |
| `outboundDailyStampLimit` | Stamped BotMail recipients one bot may send in a day, including dashboard approvals. Integer 1–10000. Default 200. |
| `uniqueBotNames` | Default `true`. One local-part across domains. |
| `adminHost` | Dashboard hostname. Empty skips Access, and the dashboard is not served. Must be the zone or a subdomain of it. |
| `publicHost` | Hostname for `/mcp`. Not `adminHost`. A `*.workers.dev` name forces `workers_dev` on. |
| `workersDev` | Keep the workers.dev hostname. Default `true`. |
| `access.teamDomain` | Access team label, the part before `.cloudflareaccess.com`. |
| `access.aud` | Leave empty. Setup stores the audience in the state file. |
| `access.allowedEmailDomains` | Email domains that may open the dashboard. Required when `adminHost` is set. Also the company domains used for `claims_owner_domain`. |
| `branding.logo` | Empty, or an `https://` URL. |
| `branding.accent` | `#rrggbb`. Default `#7aa2ff`. |

`.env` holds `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and optionally `ADMIN_API_KEY`, `DATA_KEY`, and `CLOUDFLARE_DOMAINS_API_TOKEN`. A leftover `bots` array in the config is ignored.

## What setup does

Wrangler requires Node.js 22 or newer. `npm run setup` checks the running version before it talks to Cloudflare.

The zone must already be on this Cloudflare account. Setup looks it up with `GET /zones?name=<mailZone>`. If it is missing, setup stops and tells you to add the zone first.

`npm run setup` is idempotent. It:

1. Resolves the zone.
2. Creates the R2 bucket and D1 database when they are missing, and stores the D1 id in `bot-mail.state.json`.
3. Writes `wrangler.jsonc` and builds the dashboard into `dashboard/dist`.
4. Enables Email Routing and plus-addressing on the zone.
5. Requests routing DNS for the mail domain. If Cloudflare rejects that name, it copies the apex routing MX and SPF onto the mail domain and prints the dashboard step for the subdomain.
6. Onboards Email Sending, which publishes MX, SPF, DKIM, and a DMARC TXT at `_dmarc.<your-mail-domain>`. The Worker only checks that the TXT contains `v=DMARC1`. Edit the TXT on the zone's DNS page, then **Recheck** on **Domains**, to change the policy.
7. Applies D1 migrations, then marks `mailDomain` as the default domain. It does not insert or update mailboxes, keys, webhooks, routes, notes, or mail. On the first deploy it writes `ADMIN_API_KEY`, `DATA_KEY`, and `MAIL_DOMAIN` and deploys with those secrets. A later run does not generate new keys when `ADMIN_API_KEY` and `DATA_KEY` are already on the Worker. `CF_API_TOKEN` is uploaded when a domains token is available and the secret is missing, or when you pass `--rotate-secrets`.
8. Deploys, then points the zone catch-all at the Worker. When the rule already sends to this Worker, setup leaves it. When it already sends to a different Worker, setup stops unless you passed `--force-catch-all`. Setup never deletes a routing rule. The generated `wrangler.jsonc` has no Email Routing `addresses`, so a rerun does not fight that rule. `routing: "literal"` skips this step and writes one literal rule per mailbox instead. See [Staging](#staging).
9. When `adminHost` is set, creates or updates a self-hosted Access application and an allow policy for `access.allowedEmailDomains`, stores the app id and audience in `bot-mail.state.json`, and attaches that hostname as a Worker custom domain. A 403 from the Access API prints a warning and names the two Access permissions. The Worker still does not render the dashboard.
10. Prints the MCP URL, the dashboard URL, and tells you to add mailboxes there. The admin key is printed only when it was just created.

```sh
npm run setup -- --dry-run       # print the plan; no Cloudflare calls
npm run setup -- --status        # read-only check
npm run setup -- --teardown --yes
npm run setup -- --teardown --yes --include-data
npm run setup -- --share-deploy-token
npm run setup -- --rotate-secrets
```

`--teardown --yes` deletes the Worker and disables catch-alls that point at it. It leaves D1, R2, and routing DNS. `--include-data` also deletes the R2 bucket by name, and deletes D1 when `bot-mail.state.json` still has the database id. Time Travel cannot restore a deleted database.

`--rotate-secrets` replaces `ADMIN_API_KEY` and `DATA_KEY` together. `--rotate-keys` is ignored. A value already in `.env` is uploaded as-is. Otherwise setup generates a new admin key and prints it once.

### Success output

```
<brandName>
MCP  https://<your-botmail-host>/mcp
Dashboard https://<your-admin-host>/
Add bots at https://<your-admin-host>/bots. Setup does not create mailboxes.
Default mail domain <your-mail-domain>. Add more on https://<your-admin-host>/domains
ADMIN_API_KEY <generated value>
secrets file .bot-mail.secrets
```

If the admin key already existed, the line is `ADMIN_API_KEY already set; not printed`. `DATA_KEY` is never printed. Lines that mean the install landed: `applied D1 migrations`, `default domain <your-mail-domain> recorded`, `deployed <workerName>`, and either `catch-all updated to this worker` or `catch-all already sends to this worker`.

If `publicHost` was empty, put the hostname from the MCP line into `publicHost` and run setup again so connector URLs stay on that host.

### Workers Builds

Workers Builds does not have this config unless you provide it. For a Git deploy, set the build command to `npm run config && npm run build` and the deploy command to `npm run db:migrate:remote && npx wrangler deploy`, and supply `bot-mail.config.json` plus the D1 database id as build variables. The first-time path is `npm run setup` on a machine that has the API token. The Worker name in the dashboard must match `workerName`. The migrate step has to run before `wrangler deploy`, because the new Worker reads the latest schema.

## Deploy

`npm run deploy` builds the dashboard, rewrites `wrangler.jsonc` from the install state file, applies pending remote D1 migrations, then runs `wrangler deploy`. `npm run deploy:staging` does the same for `bot-mail.staging.json`.

Both commands read `accessAud` and `accountId` from the state file (`bot-mail.state.json` or `bot-mail.staging.state.json`) and write them as `CF_ACCESS_AUD` and `CF_ACCOUNT_ID`. If the audience is not in the state file, `access.aud` in the group config is used. If it is still missing, deploy stops. An empty audience makes the admin dashboard return 401 after Access sign-in.

`npm run deploy` does not call the routing API. Routing changes happen in `npm run setup` or `npm run route:staging`.

## Staging

Staging is a second install on its own Worker, D1 database, R2 bucket, KV namespace, and Access host. `setup:staging`, `deploy:staging`, and `route:staging` read `bot-mail.staging.json` by that name, so the file stays in the repo. It ships with placeholders: zone `example.email`, mail domain `staging.example.email`, admin host `staging-admin.example.email`, public host `staging-mcp.example.email`, Access team `your-team`, and allowed email domain `example.com`. Replace those before a live run. Commit only placeholder hostnames and team names.

State and secrets go to `bot-mail.staging.state.json` and `.bot-mail.staging.secrets`, both gitignored. Any config file other than `bot-mail.config.json` gets a sibling state file and a secrets file derived from its name. Production commands still read `bot-mail.config.json` and `bot-mail.state.json`.

The committed staging file sets `routing` to `literal` and `outboundAllowlistOnly` to `true`. Literal mode never writes the zone catch-all. It creates one literal Email Routing rule per mailbox, pointed at the staging Worker. Rules that already send to this Worker are left in place. A rule that sends somewhere else is refused. Nothing in this path deletes a rule. Because the catch-all stays with the other install, staging does not receive that install's mail.

Production setup, by contrast, writes one rule: the apex catch-all `*@mailZone`, action `worker` → `workerName`. It does not write `*@mailDomain` and it does not write a rule per mailbox. When `mailDomain` is a subdomain, setup only publishes that name's routing MX and SPF. Cloudflare's catch-all is apex-only, and literal address rules are evaluated before it.

One manual step. In **Email Routing** for the zone, open **Settings → Subdomains** and enable the label of `mailDomain` (`staging` for `staging.example.email`). Setup cannot create a subdomain catch-all.

Outbound mail from a staging install with `outboundAllowlistOnly` is limited to its own BotMail domains plus `sendAllowlist` in the staging config. Other recipients are rejected, not queued. The Settings allowlist does not widen that. The example list is empty. Operators sign in with addresses on `access.allowedEmailDomains`.

```sh
npm run setup:staging -- --dry-run
npm run setup:staging
npm run deploy:staging
npm run route:staging -- herald
BOT_MAIL_CONFIG=bot-mail.staging.json npm run bot:add -- herald --name Herald
```

`setup:staging` creates the separate resources and, for each mailbox already in the staging database, one literal rule. `deploy:staging` applies that install's remote D1 migrations, then rebuilds and deploys the Worker. It does not call the routing API. `route:staging` adds or updates the rule for one address and does not deploy. `bot:add` with `BOT_MAIL_CONFIG=bot-mail.staging.json` creates the mailbox and then the same rule. Use the same `.env` token. Do not pass `--force-catch-all` on the staging config.

## Routing

On a catch-all install, setup writes one routing rule: the apex catch-all `*@<mailZone>` (matcher `all`, action `worker` → `workerName`). It does not write `*@<mailDomain>`, and it does not write a literal rule per mailbox. When `mailDomain` is a subdomain, setup only requests routing DNS for that name (`POST /email/routing/dns`, or a copy of the apex MX and SPF) and tells you to enable the subdomain under **Email Routing → Settings → Subdomains**. This install still depends on the apex catch-all for that subdomain mail, because that is the only rule the code creates. Before setup changes the catch-all it reads it. If the rule already sends to a different Worker, setup stops unless you pass `--force-catch-all`. It never deletes a routing rule.

The Worker routes on the full address: the local-part and the domain together. `herald+alerts@<your-mail-domain>` is the mailbox `herald`. With unique names off, `herald@bot.example.email` and `herald@desk.example.email` can be two mailboxes. A D1 route can alias another address onto one or more mailboxes, or forward it to an address outside every BotMail domain. A forwarded copy is kept with folder `forwarded` only after that send succeeds.

Unknown local-parts follow `unknown_policy`: store them on the disabled `_unrouted` mailbox (the default, no webhook), SMTP-reject them, or deliver them to a default mailbox. A disabled mailbox with no forward-on-disable target falls through to that same policy. Mail for a domain that is not on the Domains page, or that is disabled there, is SMTP-rejected. Messages larger than 25 MiB are rejected.

On a catch-all install, creating a mailbox does not need a new routing rule. On a literal install, `npm run route:staging -- <local-part>` (or `bot:add` with `BOT_MAIL_CONFIG` pointing at the staging file) creates that address's rule.

## Domains

`mailDomain` in the config is the default. It cannot be disabled or removed. More domains are added on the dashboard **Domains** page, not in the config. Each mailbox belongs to one domain. Its address is `local@domain`.

On a catch-all install, adding `desk.example.email` on the zone `example.email` reuses the apex catch-all. A domain on another zone gets its own catch-all pointed at this Worker. A literal install never writes a catch-all.

With a `CF_API_TOKEN` Worker secret, adding or rechecking a domain:

1. Finds the zone and refuses the domain unless the zone belongs to this account.
2. Enables Email Routing and subaddressing, and requests routing DNS for a subdomain.
3. Points the zone catch-all at this Worker. A catch-all that already sends somewhere else is reported and never overwritten. `ROUTING_MODE=literal` skips this write.
4. Onboards Email Sending for the domain.
5. Looks up MX, the return-path MX, SPF, DKIM, and DMARC over DNS-over-HTTPS.

The page shows Routing, Sending, and DNS as Ready, Issue, Pending, or Manual. Disabling a domain rejects its inbound mail and stops its mailboxes from sending. Those mailboxes and their mail stay.

## Unique names

D1 enforces one mailbox or route per address. Creating a duplicate returns `409` with the mailbox that holds the address.

`uniqueBotNames` (default `true`) also blocks the same local-part on two domains, so the group has one `herald`. Turn it off in the config, or with the switch on Settings, to allow `herald@bot.example.email` and `herald@desk.example.email` side by side. The switch refuses to turn back on while such duplicates exist and names them.

Ids stay unique across all domains. The second `herald` gets the id `herald.desk` (the domain's first distinctive label, skipping words like `bot` and `mail`), then `herald.<domain-with-dashes>`, then `herald-2`. Wherever two mailboxes share a name, the dashboard shows the domain next to it.

Ids match `^[a-z][a-z0-9._-]{0,62}$` and cannot start with `_`.

## Mailboxes, owner, and notes

A mailbox has a display name, an address, optional notes, and an optional owner.

**Notes** are free text, up to 2000 characters, for what the mailbox is for. Edit them on the bot page, set them in **New bot**, pass `notes` to `create_bot` and `update_bot`, or fill the optional notes field when you create a mailbox on the Connect page. Lists show a notes hint on hover. Archive keeps the notes.

**Owner** is `bots.owner_email`, added by migration `0021`. It is separate from notes. The column is nullable, so every mailbox that existed before `0021` stays unowned until someone saves an address.

The owner is recorded when a mailbox is created from a signed-in Access session:

- **New bot** on the dashboard stores the email from a verified `Cf-Access-Jwt-Assertion`. A header that only claims an email is ignored.
- The Connect page stores that same verified email when you choose **Create a new mailbox**.

If the JWT cannot be verified, the owner is stored as null. Dashboard creation still requires a valid Access session, so that path has an owner whenever Access is configured. `create_bot` on the admin MCP does not take an owner, and the row stays null. You can fill it later on the bot page.

Choosing an existing mailbox on the Connect page does not write `owner_email`.

On the bot page, **Save owner** sets or clears the address. A blank value clears it. Any other value must look like an email. It is stored lowercased and may be at most 254 characters. Saving the owner does not change mail, keys, the webhook, or the connector. It works for an archived mailbox.

## Connect page

Bots sign in with OAuth 2.1 and PKCE on `https://<your-botmail-host>`. The approve page is on the admin host, behind Cloudflare Access. A request to `/oauth/authorize` on the public host redirects there.

1. Add a connector named **BotMail** with URL `https://<your-botmail-host>/mcp` and no headers.
2. Add an account named by the mailbox id.
3. Click **Connect** and sign in with an email on `access.allowedEmailDomains`.
4. The page offers two choices.
   - **Existing mailbox.** Search by display name, id, address, or notes. Mailboxes that already have a connection are hidden. Revoke the connection on the bot page before that mailbox can be chosen again.
   - **Create a new mailbox.** Enter a local part, a display name, and optional notes. The address uses the default mail domain. The owner is the Access email from this sign-in.

Approve sends the token to exactly one mailbox. Deny sends the bot back without a grant.

One mailbox keeps one connection. D1 records it when the authorization code is exchanged for a token. A second grant cannot take that mailbox. An approval that never finishes does not hide the mailbox, and it expires after about 10 minutes. Approving the same mailbox again from the same client replaces that in-flight grant. The connection row stays after revoke, marked revoked. Refresh tokens do not expire on a timer. Revoke is what stops one. Turning the mailbox back on does not restore the connector.

A static `bm_…` key still works for scripts and for a client that cannot sign in. The admin key is a different credential. It cannot read a mailbox.

## Aliases and the address registry

An alias delivers a separate copy into each mailbox it targets. The copy records the alias address on `via_alias`. Archiving an alias stops routing and leaves the mail in place. The address stays reserved. A bot may send with `from` set to an alias that currently targets its own mailbox.

Changing a mailbox address on the bot page keeps the same id, mail, webhook, and connector. The previous address becomes an alias for that mailbox. The connector is stored by mailbox id, not by the address string. On a literal-routing install, add a literal rule for the new address and leave the old rule in place.

Forward on disable is a setting on the mailbox. While that mailbox is disabled, new inbound mail is stored there and, unless it is junk or quarantine, copied to one other BotMail mailbox if that mailbox is active. The rule does nothing while the mailbox is on. A disabled target does not forward again.

`address_registry` is the unique key for every address: mailboxes, aliases, and external forwards, including disabled and archived ones. The key is the lowercased `local@domain`. Migration `0020` creates the table and copies existing mailbox and route addresses into it. It does not update message rows, so `via_alias` stays null on mail that arrived before it.

Registry rows are never deleted. The Worker refuses a delete, and the address stays reserved because `address` is the primary key. Migration `0022` adds `removed_at` on `address_registry`, but no Worker path sets that column. Lookup does not treat a registry row as gone.

### Soft delete

Removing a mailbox from an alias does not delete the `alias_targets` row. The Worker sets `removed_at` to the current time. Putting that mailbox back on the same alias clears `removed_at` and keeps the original `created_at`.

Reads that decide delivery, the routing list, and which aliases a bot may use as `from` ignore rows with `removed_at` set. If every target of an alias has been removed, the alias delivers to nobody. It does not fall back to the old `routes.target` column.

Migration `0022` only adds the columns. Existing rows stay active (`removed_at` is null). Apply `0022` before the Worker that selects `removed_at` starts. `npm run setup`, `npm run deploy`, and `npm run deploy:staging` apply pending remote D1 migrations before they deploy that Worker.

## Sending

`approval` (the default) sends immediately to any enabled BotMail domain or the allowlist. Any other recipient is saved as `pending_approval` until an admin approves it on the Mail page or with `approve_draft`. `direct` sends every recipient immediately. Use it only when an upstream gate already reviews outbound mail.

Saving the policy on Settings stores `send_policy_source=dashboard`, which overrides the `SEND_POLICY` var until the source is set back to `config`. Inbound rate limits and the junk threshold override the same way with `inbound_policy_source`. The config allowlist and the dashboard allowlist are combined. `outboundAllowlistOnly` still rejects recipients outside this install's domains and the config allowlist. The dashboard list does not widen that gate.

`set_send_policy` on the admin MCP stores the policy. While `send_policy_source` is not `dashboard`, a `SEND_POLICY` var from the group config stays in force.

## Inbound trust, quarantine, and junk

Each message stores `auth_result`, `auth_passed`, `quarantine_reason`, `hop_count`, and `spam_score`. The auth fields are on the MCP message objects. The wake payload includes `auth_result` and `claims_owner_domain`. Quarantine keeps the message. Release moves it to the inbox and then wakes the webhook.

### Stamps

`auth_result` is `internal` only when the inbound message carried one valid `X-BotMail-Stamp` from this Worker. The stamp is an HMAC over a stamp id, the time it was issued, the sender, that recipient, and a SHA-256 of the normalized subject and body. The HMAC key is derived from `DATA_KEY` with HKDF and info `botmail-stamp-v1`. There is no separate stamp secret.

A send to a BotMail recipient fails when the stamp cannot be built. Recipients outside those domains get a separate copy with no stamp. `Auto-Submitted: auto-generated` and `X-BotMail-Hops` are added only on a bot send to a BotMail recipient, not on outside copies and not on a send a person approved. If only one of those sends succeeds, the row is `partial` and records both Message-IDs.

The stamp is removed before the message is stored. A stamp older than 7 days, or one reused with a different subject or body, does not verify. A second copy of the same stamp is not stored again. A duplicate does not replace a stored `.eml`. A missing object is filled only when the subject, body, and attachment sizes and digests match.

A valid stamp is internal mail: it is delivered and it wakes the bot. Stamped mail from one sender to one mailbox is capped at `inboundBotRateLimit` per hour (default 30).

A forward happens only after the stamp verifies. The forwarded copy does not include the hop header or `Auto-Submitted`, and the stored folder is `forwarded` only after that send succeeds. The hop header on outside mail is ignored. On a verified stamp it is stored in `hop_count` at ingest.

### Auto-reply and daily caps

Every connector send to a BotMail recipient counts toward the auto-reply window, whether or not the caller sets `automated`. Only a dashboard approval or admin `approve_draft` is exempt. The count compares normalized mailbox addresses, so a plus tag is the same recipient. The window is `inboundAutoReplyWindow` seconds (default 3600), and the limit is `inboundAutoReplyLimit` (default 20). Over the limit, the send fails and a stamped copy is quarantined as `auto reply loop`.

Each bot also has `outboundDailyStampLimit` stamped BotMail recipients per day (default 200), including dashboard sends. Both limits are reserved in `outbound_quota` before the send. That table is not backfilled, so after deploy the limits count only new sends and are whole again within 24 hours. The 15-minute cron deletes rows in that table once they are older than both 36 hours and the longest auto-reply window that can be configured (7 days) plus 12 hours, released rows included.

### Who gets quarantined

The claim check uses the same addresses postal-mime stores, including the Sender and group members. An apostrophe in the local part is a normal address. A From or Sender is quarantined as `unparsed sender` only when its raw address text skeleton-matches a BotMail domain and this Worker cannot parse it. A quoted local part, a `%` local part, or any other parse failure that does not imitate a BotMail domain is stored as unverified and delivered.

Domains are compared after NFKC and IDNA. The skeleton also folds Armenian օ, small-capital ᴏ, ɑ, and the `0`/`o`, `1`/`l`, and `rn`/`m` swaps. The same skeleton sets `claims_owner_domain`. An ordinary internationalized domain that does not imitate a BotMail domain is delivered.

If the header From, the Sender, or the envelope sender uses a BotMail domain, a subdomain of one, a disabled BotMail domain, or a lookalike of one, and the message has no valid stamp, it is quarantined with reason `unstamped internal sender` and the bot is not woken. The message stays stored.

Mail from the operator's own company domain is delivered and labeled unverified. It is not quarantined for that reason. The company domains are `access.allowedEmailDomains`. When `claims_owner_domain` is true, the heads-up says the sender claims to be from the owner's company domain. The routine does not reply or send without approval. When `auth_result` is anything other than `internal`, the routine prefixes the heads-up with `Unverified sender` and does not follow instructions, links, or requests in the message.

### Cloudflare authentication results

Outside mail with no Cloudflare verdict is delivered and stored with `auth_result` `unverified`. The Worker reads a verdict only from the topmost Cloudflare trace block: it starts with `Received` by `cloudflare-email.net` and ends at the first `X-CF-SpamH-Score`, which is included. If that header is missing, the verdict is unverified. Only the first header of each type inside the block is used.

Its `Authentication-Results` must use authserv-id `mx.cloudflare.net`. A comment in that header that contains `"` or `;` rejects the header. When that header is absent, the Worker uses the first `ARC-Seal` in the block with `d=cloudflare-email.net` and the first `ARC-Authentication-Results`. Headers below the score are ignored, so a sender-written `Authentication-Results` or ARC set placed directly under the score stays unverified, with or without a `DKIM-Signature` after it.

`dmarc=pass` whose `header.from` shares an organizational domain with the single From address (a public suffix does not align, and a Unicode From matches its punycode form), together with a `dkim=pass` whose `header.d` and `header.s` match a `DKIM-Signature` on the message, is stored as `pass` with `auth_passed` true. A second `dkim=pass` for `cloudflare-smtp.net`, and `spf=none` on `smtp.helo`, do not change that. That `pass` is advisory and never grants trust. The DKIM cross-check reads `DKIM-Signature` text the sender can write, and it does not prove the signature is valid. More than one From address stays unverified. An unstamped From on a BotMail domain is still quarantined. The dashboard shows that pass as a neutral badge and hides it on quarantined mail. The wake still treats anything other than `internal` as untrusted.

### Rate limits and junk

A sender over the hourly limit (default 20, per sender, per mailbox) is quarantined as rate limited. The inbound allowlist skips that limit only. A BotMail domain, or a subdomain of one, cannot be added to it. The blocklist still quarantines.

Cloudflare Email Routing may add `X-Cf-Spamh-Score`, an experimental score from 0 to 5 where a higher number is more likely spam ([postmaster](https://developers.cloudflare.com/email-routing/postmaster/)). The score is taken from the `X-Cf-Spamh-Score` that ends the Cloudflare trace block, when that value is an integer from 0 to 5. Extra copies below the block are ignored. A missing header, a value outside that range, or a score that is not inside the block is null.

A score at or above `spamScoreThreshold` (default 4) is filed in `junk` instead of the inbox. Junk is kept, the bot is not woken, and the message is not forwarded. Quarantine is decided first and wins. Mail with a valid stamp stays in the inbox even when the score is high. `off` stores the score and leaves the message in the inbox.

The Mail page has a Junk view, shows the score, and **Not junk** moves the message to the inbox, marks it unread, and then wakes the webhook. It does not run a routing forward. `list_messages` omits junk unless `folder` is `junk`. `search_messages`, `get_thread`, `get_message`, `reply`, `mark_read`, `list_attachments`, and `get_attachment` omit junk unless `include_junk` is true. `get_message` and `reply` on a junk id without that flag return the same not-found result as a missing id.

Migration `0019` adds `spam_score` and does not backfill rows. Older messages keep a null score.

## Webhooks and routines

Webhook, when configured:

```
POST <url>
Content-Type: application/json
Authorization: Bearer <sender key>
X-Automation-Key: <sender key>

{
  "event": "email_received",
  "bot": "herald",
  "address": "herald@<your-mail-domain>",
  "message_id": "<d1 id>",
  "from": "ada@example.com",
  "subject": "Watch this",
  "snippet": "first 180 characters",
  "thread_id": "<thread id>",
  "received_at": "<received at>",
  "auth_result": "unverified",
  "claims_owner_domain": true
}
```

No body and no attachments. Failures are rows in `webhook_deliveries` and are retried every 15 minutes, up to 8 attempts. A disabled or archived bot is not woken, including **Send test wake** and a queued retry. Disabling, archiving, or changing the URL cancels queued deliveries. Disable and archive clear the webhook ciphertext. The URL stays.

A webhook cannot be saved while the mailbox is off, and outstanding setup codes are marked used. Re-enable and restore do not put the ciphertext back, so save the webhook again after the mailbox is on. A delivery cancelled while the request is in flight stays cancelled.

The sender key is AES-GCM encrypted in D1 with `DATA_KEY`. The URL must start with `https://`. `set_webhook` and `POST /webhook-setup` strip one leading `Bearer ` and surrounding whitespace. An empty key is rejected and does not save the URL. The literal `[REDACTED]` is rejected and not stored. A masked secret passed into an MCP tool argument arrives as that literal.

The usual routine is named exactly `BotMail inbox`. Its prompt lists unread mail through this mailbox, sends one short heads-up per message, treats anything other than `auth_result` `internal` as unverified, and marks the message read. The skill text is in [`skills/botmail-mailbox-setup/SKILL.md`](../skills/botmail-mailbox-setup/SKILL.md).

After the routine is saved, the bot sends one short message. When its latest status reminder shows field links, it copies them. Otherwise it builds both links from the folder id in the save result (`folder <id>`). It asks for the **Routine Webhook key** with a masked form of that label, calls `webhook_setup_code`, and POSTs `{code, url, key}` to `https://<your-botmail-host>/webhook-setup` from its own shell. Then press **Send test wake** on the bot page.

`/mcp` is remote Streamable HTTP on `publicHost`. It is not behind Access. An OAuth connector, or a static mailbox key, sees only that one mailbox: `list_messages`, `get_message`, `search_messages`, `get_thread`, `mark_read`, `list_attachments`, `get_attachment`, `create_draft`, `list_drafts`, `send_draft`, `send_email`, `reply`, `set_webhook`, `webhook_setup_code`.

`webhook_setup_code` returns a one-time code that expires in 10 minutes. That endpoint is rate-limited to 20 requests a minute per client IP. Unauthenticated MCP calls get `401` with `WWW-Authenticate` pointing at the protected-resource metadata.

`list_attachments` returns metadata. `get_attachment` returns `text` for `text/*` and `base64` plus `content_type` otherwise. A file over 256 KiB fails with an error and no bytes. `send_email` and `reply` accept up to 20 attachments as base64.

The admin key, on `/mcp` only, sees `create_bot`, `update_bot`, `list_domains`, `rotate_key`, `set_webhook`, `list_pending_drafts`, `approve_draft`, `reject_draft`, `set_allowlist`, `set_send_policy`, `backfill_attachments`, `drain_webhooks`.

## Secrets

Back up `.bot-mail.secrets` before you rotate anything. It is gitignored. `bot:add` writes it mode `600`. Setup's own write does not set the mode, so run `chmod 600 .bot-mail.secrets` after the first install and keep an offline copy. Losing the file does not delete mail.

| Secret | Where it lives | Who uses it | How to rotate |
| --- | --- | --- | --- |
| Deploy token | `CLOUDFLARE_API_TOKEN` in `.env` | Setup and Wrangler. Not a Worker secret unless you passed `--share-deploy-token`. | Create a new token, replace `.env`, and revoke the old token. |
| `ADMIN_API_KEY` | Worker secret, and `.bot-mail.secrets` when setup generated it. Printed once on that run. | Bearer token for admin MCP tools on `/mcp` only. The dashboard rejects it. | `npm run setup -- --rotate-secrets` replaces it and `DATA_KEY` together. Update every script that stored the old key. |
| `DATA_KEY` | Worker secret, and `.bot-mail.secrets` when setup generated it. Not printed. | Encrypts Routine Webhook keys. Signs attachment URLs. Also derives the `X-BotMail-Stamp` HMAC key with HKDF and info `botmail-stamp-v1`. There is no separate stamp secret. | Same `--rotate-secrets` run. Old ciphertext does not decrypt. Save each Routine Webhook key again. Mailbox key hashes do not depend on `DATA_KEY`. A stamp written with the old key no longer verifies. If the From is a BotMail domain, that in-flight message is quarantined as unstamped internal sender. |
| Mailbox API key | Shown once by **New bot** or **Reveal new key**. D1 keeps only a hash. | Scripts and the local bridge, as `Authorization: Bearer <key>`. A remote connector does not use it. | **Reveal new key**, or admin MCP `rotate_key`. The previous key stops working. Archive and disable clear the hash. Restore and re-enable do not bring it back. |
| Routine Webhook key | The routine's Webhook key field. D1 stores ciphertext only. | Worker POST to the routine URL when mail arrives and when you press **Send test wake**. | The bot calls `webhook_setup_code`, then its shell POSTs `{code, url, key}` to `https://<your-botmail-host>/webhook-setup`. You can also paste a new value on the bot page. Disable and archive clear the ciphertext. Save it again after the mailbox is back. |
| `CF_API_TOKEN` | Worker secret. | The Worker, when the Domains page provisions a domain. Never sent to the browser. | `npx wrangler secret put CF_API_TOKEN`, or `--rotate-secrets` (that also rotates the admin key and `DATA_KEY`). |

`MAIL_DOMAIN` is also a Worker secret. It is the mail domain string, not a credential. Setup rewrites it when it is missing or when you pass `--rotate-secrets`.

## Migrations

`npm run setup` applies every file in `migrations/`. `npm run deploy` and `npm run deploy:staging` do the same for that install: `npm run db:migrate:remote` runs before `wrangler deploy`. You can also run `npm run db:migrate:remote` yourself and then send any request to the Worker.

Every migration is additive. They add columns, tables, and indexes, and a few of them update rows that were already disabled or archived. They copy mailbox, route, and mail rows when a table has to be rebuilt. They do not delete mail or raw `.eml` objects. An empty `domain` on an older row is filled from the default mail domain the first time the Worker handles a request or a cron run.

Apply the pending migrations before the new Worker starts. The current Worker selects columns added through `0022`, including `hop_count`, `spam_score`, `revoked_at`, `last_revoked_at`, `via_alias`, `forward_to`, `owner_email`, and `removed_at`, and it reads `address_registry` and `alias_targets`. A deploy that skips the migrate step breaks those reads. The deploy scripts already apply migrations first.

| Migration | What it adds |
| --- | --- |
| `0001` | Bots, messages, attachments, settings, webhook deliveries. |
| `0002` | The disabled `_unrouted` mailbox. Re-running is safe. |
| `0003` | Routes and the dashboard settings keys. |
| `0004` | `mail_domains`, per-mailbox `notes`, and addresses unique per domain. Bots and routes are copied into new tables. Existing rows get an empty domain, filled later by the Worker. |
| `0005` | `deleted_at` on bots, routes, and domains. Existing rows stay active. |
| `0006` | `attachments.inline` and `messages.attachments_checked`. |
| `0007` | `auth_result`, `auth_passed`, and `quarantine_reason`. Existing rows stay empty, so they are not quarantined because of the migration. |
| `0008` | `oauth_grant_use`, the last time a connector called `/mcp`. |
| `0009` | `oauth_connection`, one row per mailbox. |
| `0010` | Webhook setup codes and the per-IP rate-limit table. |
| `0011` | `inbound_stamps`. One row per stamp id per mailbox. A later copy is not stored again. |
| `0012` | `messages.hop_count`, default 0. |
| `0013` | `outbound_quota`. No backfill. After deploy, limits count only new sends. |
| `0014` | Clears webhook ciphertext and cancels queued deliveries for mailboxes that were already archived. Rows stay. |
| `0015` | `oauth_connection.revoked_at`. Marks connections for already-archived mailboxes revoked. |
| `0016` | Index on messages by received time and id, for inbox pages. |
| `0017` | Clears API key hashes, webhook ciphertext, queued deliveries, and connectors for mailboxes that were already disabled, and marks their setup codes used. |
| `0018` | `oauth_connection.last_revoked_at`. Does not change existing rows. |
| `0019` | `messages.spam_score`. Existing rows stay null. |
| `0020` | `address_registry`, `alias_targets`, `messages.via_alias`, and `bots.forward_to`. Copies existing mailbox and route addresses into the registry. Does not update message rows. |
| `0021` | `bots.owner_email`. Nullable, so every existing mailbox stays unowned. Connecting to an existing mailbox does not write it. |
| `0022` | `alias_targets.removed_at` and `address_registry.removed_at`. Existing rows stay active. |

`0017` cannot revoke KV grants. `revoked_at` is what rejects those tokens. After a deploy that applies `0017` for the first time, turn **Receive mail** off once more for each mailbox that migration touched. That second disable purges its KV grants. `0018` keeps `last_revoked_at` after a new Connect, and a grant from before that time cannot take the mailbox.

Archive is a timestamp and a disabled flag (`deleted_at`). The Worker does not delete the mailbox row, its mail, or the object in R2. Restoring a mailbox keeps the id, notes, and messages. The old key, webhook ciphertext, and connector are cleared on archive and are not restored. An archived address stays reserved so the restore still fits.

Attachment columns start empty on older messages, so **Extract stored attachments** can parse their stored `.eml` files. New mail is scanned as it arrives.

## Upgrading

Save a D1 Time Travel bookmark before setup writes anything. From the repo root, with the existing `wrangler.jsonc` still on disk:

```sh
git pull
npm install
npx wrangler d1 time-travel info <d1-name> --timestamp <utc-time>
npm run setup
```

Use the current UTC time and save the bookmark the command prints. A rerun updates the Worker, applies migrations, and rewrites config vars. It does not insert, update, or delete mailboxes, keys, webhooks, routes, notes, or mail. It does not rotate `ADMIN_API_KEY` or `DATA_KEY` when those secrets are already on the Worker.

`npm run setup -- --rotate-secrets` replaces those two secrets. After a new `DATA_KEY`, save each Routine Webhook key again. A stamp written with the old key no longer verifies. If the From is a BotMail domain, that in-flight message is quarantined as unstamped internal sender.

To restore the bookmark you saved:

```sh
npx wrangler d1 time-travel restore <d1-name> --bookmark <bookmark>
```

`--timestamp` within the last 30 days works when you do not have the bookmark string. Time Travel rewinds D1 only. R2 `.eml` objects stay as they are.

## Recovery

**Archived mailboxes.** On **Bots**, **Show archived**, then **Restore**. If the domain is archived, restore that domain first. Archive clears the API key hash and the webhook ciphertext, cancels queued deliveries, and marks the OAuth connection revoked. The row stays. Restore does not bring those back. **Reveal new key** or Connect again, and save the webhook again. The previous key does not work.

**Disabled mailboxes.** Turning **Receive mail** off clears the API key hash and the webhook ciphertext, cancels queued deliveries, marks outstanding webhook setup codes used, revokes the connector, and stops webhooks. Doing it again clears them again. Turning it back on does not restore the key, the webhook ciphertext, or the connector. Reveal a new key or add the account and click Connect again, then save the webhook again. An authorization code approved before the disable cannot be exchanged after the mailbox is back on. See migration `0017` in [Migrations](#migrations) for mailboxes that were already disabled when that migration ran.

**Redeploy with the same secrets.** Keep `.env`, `bot-mail.config.json`, `.bot-mail.secrets`, and `bot-mail.state.json`. `npm run setup` finds R2 and D1 by name. If the Worker is gone, or it has no `ADMIN_API_KEY` / `DATA_KEY` yet, setup uploads the values from `.env` when those are set, otherwise the values in `.bot-mail.secrets`. It generates a new pair only when both places are empty. Mailbox key hashes in D1 keep working. A generated `DATA_KEY` cannot read old webhook ciphertext. Save each Routine Webhook key again. If listing Worker secrets fails for a reason other than a missing script, setup leaves existing secrets in place and does not generate replacements.

## Troubleshooting

The short table is in [the README](../README.md#troubleshooting). A few longer causes:

- **Catch-all already points at another Worker.** Setup stops and names that Worker. Pass `--force-catch-all` only when this install should take the apex catch-all. Staging uses literal rules and should not pass that flag.
- **Subdomain mail never arrives.** Enable the `mailDomain` label under **Email Routing → Settings → Subdomains**. A catch-all exists only for the apex. A literal install needs one rule per address (`npm run route:staging` or `bot:add` with `BOT_MAIL_CONFIG` set).
- **Reads fail immediately after deploy.** The Worker is selecting a column the database does not have yet. Run `npm run db:migrate:remote` for that install, then deploy again. `0021` is required for `owner_email`. `0022` is required for `removed_at`.
- **A mailbox is missing on the Connect page.** It already has a connection, or it is disabled or archived. Revoke the connector on the bot page. An approval that was never exchanged expires after about 10 minutes and does not hide the mailbox.
- **Owner is blank on an older mailbox.** Migration `0021` leaves existing rows null. Connecting does not fill it. Save an owner on the bot page, or create the mailbox from the dashboard or the Connect page.
- **Webhook key will not save.** The mailbox is off, the URL is not `https://`, the key is empty, or the value that arrived was the literal `[REDACTED]`. The setup code expires in 10 minutes, works once, and the POST is limited to 20 requests a minute per client IP.

## Manual fallbacks

Setup prints these and continues when the API cannot finish the step:

- Subdomain routing: **Compute → Email Service → Email Routing → the zone → Settings → Subdomains**, add the label of `mailDomain` (for `bot.example.email`, the label is `bot`). The dashboard form is the fallback that locks the subdomain's routing DNS, including the DKIM selector.
- Email Sending: **Compute → Email Service → Email Sending → Onboard Domain**, choose `mailDomain`.
- Catch-all, if the API call fails: **Email Routing → the zone → Routing rules → Catch-all address**, action **Send to a Worker**, choose `workerName`. Do not add `addresses` to `wrangler.jsonc`.
- Plus-addressing: **Email Routing → Settings** if the settings update fails.
- Access, when `adminHost` is set: **Zero Trust → Access → Applications → Add a self-hosted application** for that hostname. Policy Allow, include each `access.allowedEmailDomains` entry. Copy the application audience into the state file as `accessAud` and run setup or deploy again so the Worker var matches. Deploy reads `accessAud` and `accountId` from that state file and stops if the audience is still empty.
- Custom domain: **Workers → the script → Settings → Domains & Routes → Add** `adminHost`.

Reference: [Email Routing enable](https://developers.cloudflare.com/api/resources/email_routing/methods/enable/), [catch-all update](https://developers.cloudflare.com/api/resources/email_routing/subresources/rules/subresources/catch_alls/methods/update/), [routing DNS](https://developers.cloudflare.com/api/resources/email_routing/subresources/dns/methods/create/), [subdomains](https://developers.cloudflare.com/email-service/configuration/subdomains/), [sending subdomains](https://developers.cloudflare.com/api/resources/email_sending/subresources/subdomains/methods/create/), [Worker secrets](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/update/), [static assets](https://developers.cloudflare.com/workers/static-assets/).

## Add a mailbox from the terminal

```sh
npm run bot:add -- herald --name Herald
npm run bot:add -- herald --domain desk.example.email --notes 'Desk alerts'
```

`bot:add` calls `create_bot` on `https://<your-botmail-host>/mcp` with `Authorization: Bearer <ADMIN_API_KEY>` (from the environment or `.bot-mail.secrets`), stores the new key in `.bot-mail.secrets` (mode 600), and does not print it. The admin key works only on `/mcp`. This path does not set `owner_email`. Set the owner on the bot page if you need one.

## Attachments backfill

Mail stored before attachments were extracted still has the raw `.eml` and no attachment rows. On Health, **Extract stored attachments** parses those files once. The same scan from a terminal:

```sh
npm run attachments:backfill
npm run attachments:backfill -- --limit 100
```

It calls `backfill_attachments` with `ADMIN_API_KEY` and prints counts, not file bytes. Each message is marked scanned, including ones with no files. The limit defaults to 25 and maxes at 100.

## Local bridge

A local stdio bridge (`bin/botmail-mcp`) is only for a client that cannot complete OAuth sign-in. Remote connectors are the primary path. The bridge is what a machine reset destroys. The remote connector is not.

To move a mailbox off the bridge: remove the local connector, add an account named `<id>` on the shared BotMail connector (`https://<your-botmail-host>/mcp`, no headers), click Connect, and sign in. Leave the routine webhook as it is.

Fallback:

```sh
npm run bot:add -- herald --origin https://<your-botmail-host>
bin/botmail-mcp herald https://<your-botmail-host>/mcp
```

`bot:add` appends the new key to `.bot-mail.secrets` and does not print it. The bridge refuses any other file mode, then runs `npx mcp-remote` with the header. Static bearer keys still work, so a script you have not moved yet keeps calling `/mcp` with `Authorization: Bearer <key>`.

## Public mirror

Pushes to `main` can publish a snapshot of that commit to a separate public repository. The public repository does not receive this repository's history. Each publish replaces the tree and adds one commit. The job waits for approval, and it pushes nothing when the snapshot or the commit message contains a denied string.

### One-time setup

1. Create an empty public repository. Leave README, `.gitignore`, and license unchecked so the repository has no commits and no default branch.
2. On that repository, add a deploy key and allow write access. Keep the private key.
3. In this repository, open **Settings → Environments** and create an environment named `public-release`. Add yourself as a required reviewer. Limit deployment branches to `main`.
4. On `public-release` (environment secrets, not repository secrets), add:
   - `PUBLIC_REPO_DEPLOY_KEY`: the private half of the deploy key.
   - `PUBLIC_SYNC_DENYLIST`: strings that must not appear in the public snapshot or the commit message, one per line. Matching is case-insensitive. Include internal names, email domains, the Cloudflare account id, and the Access team name. An empty value fails the job.
5. Add a variable named `PUBLIC_REPO` on that same environment, or as a repository variable. The value is `owner/name`, for example `example-owner/example-repo`. An environment variable wins when both are set.

`PUBLIC_REPO_DEPLOY_KEY` has to be an environment secret. A repository secret of the same name is available to every workflow without this approval, and GitHub uses that repository secret when the environment secret is missing. Do not create one. Keep the denylist in the environment secret too. Do not commit it.

`.public-sync-exclude` lists paths that stay in this repository. The sync workflow is on that list.

### Approval

`.github/workflows/public-sync.yml` runs on every push to `main`, and from **Run workflow** on `main`. The publish job sets `environment: public-release`, so GitHub starts none of its steps until a required reviewer approves the deployment. The deploy key is injected only after that approval, and the job cannot authenticate to the public repository before then.

The job exports the tracked files at the triggering commit, drops the exclude list, and scans every remaining file and the triggering commit message. A match prints the file path and line number only. The job then stops, and it does not push. When the scan is clean it clones the public repository (depth 1), replaces the tree, and commits only when something changed. The message is the triggering commit's subject and body. The first run on an empty public repository creates `main`.

Author and committer are `Joshua Mirabella <29336554+jmirabella@users.noreply.github.com>`. That GitHub noreply address links the commit to the owner's profile. Optional variables `PUBLIC_SYNC_AUTHOR_NAME` and `PUBLIC_SYNC_AUTHOR_EMAIL` override the pair. Leave both unset to keep this default.

**Run workflow** has a boolean input, `replace_history`, default off. It is a rare manual repair. With it on, the job still waits for approval on `public-release` and still runs the leak scan first. It then publishes the export as one root commit and force-pushes that commit to public `main`, and the log says it is replacing public history. A push to `main` never force-pushes. Leave the input off for an ordinary publish, which adds one commit on top of public `main`.

`npm test` reads `PUBLIC_SYNC_DENYLIST` in `test-node/setup.test.mjs` when the variable is set, and skips that guard when it is unset.

### Direction

Changes move from this private repository to the public one. Apply outside contributions here first. The next approved sync publishes them.

## Develop

```sh
npm install
npm test
npm run typecheck
```

`npm run dev` builds the dashboard and starts `wrangler dev`. For live dashboard edits, run `npx vite build --config dashboard/vite.config.ts --watch` alongside it.

Tests build the dashboard and generate `wrangler.jsonc` from `test/group.config.json`. Keep new tests to a handful per feature (see `AGENTS.md`).
