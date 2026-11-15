# THESIS persistence (TigerData / PostgreSQL)

For Taha (backend review and deploy) and Anne (website integration). Branch: `thesis_engine`.

## What changed, in one paragraph
**Database mode (TigerData):**
- Theses, onboarding sessions, chat, news evidence and notifications can now be stored in TigerData (PostgreSQL) instead of only `data/db.json`.
- Nothing is overwritten. Each user can have many theses, each with its own evidence history, notification record and chat conversations, plus a timeline that ties them together.

**Unchanged:**
- The AI engine (`server/thesis.js`) is still stateless; the backend loads and saves around it.
- The existing single-thesis routes and their responses are unchanged.
- Without the database setting, everything runs on the JSON file exactly as before.

## Turning it on
| `LOOP_DB` | Storage | Use |
|---|---|---|
| unset / `json` | `data/db.json` (as before). `/api/v2` answers 503 | tests, quick local runs |
| `postgres` | TigerData at `DATABASE_URL` (TLS, connection pool) | Render / production |
| `pglite` | PostgreSQL inside the Node process, saved in `LOOP_PGLITE_DIR` (default `data/pglite/`) | local development without TigerData |

- **`DATABASE_URL` on its own does nothing:** `LOOP_DB=postgres` must be set too. That way a developer's `.env` can't quietly point local runs or tests at the real database.
- **If the database can't be reached, the server doesn't start.** It exits with code 1 and logs a one-line `[storage] FATAL…` with no credentials or host, so a deploy fails visibly instead of running on temporary data.
- **Migrations** run automatically at boot. They're additive only (`CREATE … IF NOT EXISTS`), applied once, under an advisory lock. To run them by hand: `LOOP_DB=postgres npm run db:migrate`.
- **One-time import (optional):** `STORE_IMPORT_JSON=true` copies an existing `data/db.json` into an *empty* database on first boot. The file is only read.
- **TLS:** TigerData connection strings include `sslmode=require`, and the string decides. Without `sslmode`, TLS is still required and the certificate is verified. `PGSSL_REJECT_UNAUTHORIZED=false` is only for a self-signed development database.

## Running locally on TigerData (schema `thesis_dev`)
This folder and the original `LOOP/` folder point at the **same** TigerData service. To keep them apart, this
copy writes only into its own schema, `thesis_dev`, and never touches `public`.

| Variable | Value | Why |
|---|---|---|
| `LOOP_DB` | `postgres` | turns the database on (`DATABASE_URL` alone never does) |
| `DATABASE_URL` | from `.env` (never commit or print it) | the TigerData connection string |
| `PGSCHEMA` | `thesis_dev` | **required** with `postgres`. The server refuses to start without it |
| `PGSSLROOTCERT` | `certs/timescale-ca.pem` | TigerData signs with its own CA, `ca.timescale.com`. Node rejects it unless it is pinned |

**Schema isolation:**
- The `search_path` is a connection *startup* parameter, so it applies to every pooled connection from its first byte. There is no async setup step, so nothing can race it.
- Every connection is checked once (`current_schema()` must equal `PGSCHEMA`) before its first query or transaction.
- On a mismatch the connection is destroyed and the request fails with `SCHEMA_MISMATCH` (or the server doesn't boot). It never falls back to `public`.

**TLS:**
- The CA is pinned, and both the certificate and the hostname are verified.
- The `sslmode` parameter in the URL is ignored when `PGSSLROOTCERT` is set, because `pg` would otherwise let it override the pinned CA.
- CA fingerprint (SHA-256): `06:5A:75:0D:0D:64:F6:2D:AC:DC:97:9E:3B:83:D2:11:95:40:71:EA:59:B8:F3:40:7C:4E:87:CA:68:34:64:57`, valid until 2027-10-20.
- The file was taken from the server's own chain. Compare it with the CA offered in the Timescale console.

The npm scripts below set all four variables inline, so `.env` needs no change:
```
npm run db:migrate:tigerdata          # additive migrations into thesis_dev (safe to re-run: "already up to date")
npm run start:tigerdata               # the site on http://localhost:3000, data in TigerData/thesis_dev
npm run db:inspect                    # read-only: tables, row counts, foreign keys, latest theses/evidence/chats
npm run db:verify                     # + 21 relationship checks (exit 1 on any violation)
npm run db:inspect -- --snapshot F    # save each row's id + content hash; later: --compare F (fails if a row vanished)
npm run demo:persistence:tigerdata    # end-to-end walkthrough with HYPOTHETICAL rows (no Gemini, email or trades)
```

**Confirming it's connected:**
- The boot log says `[storage] postgres ready (schema thesis_dev)`.
- `GET /api/health` shows `storage.backend = "postgres"`, `storage.schema = "thesis_dev"` and `pendingWrites: 0`.

**Inspecting saved theses, chats and evidence:**
- Use `npm run db:inspect`, or SQL in the Timescale console. Always schema-qualify:

  ```sql
  SELECT thesis_id, user_id, goal, monitoring_status, created_at FROM thesis_dev.theses ORDER BY created_at DESC;
  SELECT m.match_id, m.stance, a.headline, a.url, m.assessed_at FROM thesis_dev.thesis_matches m JOIN thesis_dev.news_articles a USING (article_id);
  SELECT conversation_id, seq, role, left(content, 80), citations, created_at FROM thesis_dev.chat_messages ORDER BY conversation_id, seq;
  ```
- Or through the API, with `X-User-Id`: `/api/v2/theses`, `/api/v2/theses/:id/matches`, `/api/v2/theses/:id/conversations`, `/api/v2/conversations/:id/messages`, `/api/v2/theses/:id/timeline`.

**Citations are linked by id:**
- Each saved assistant citation carries `matchId` and `articleId`, which point to the stored evidence and article it came from.
- These fields are additive. The chat logic is unchanged: the route resolves them after `thesisChat` returns.

**Returning to offline JSON mode:** use plain `npm start` (no `LOOP_DB`). It uses `data/db.json` exactly as before, and `/api/v2` answers 503.

**Starting the real site without real side effects:** blank the keys for that run, for example
`GEMINI_API_KEY= N8N_NOTIFY_WEBHOOK_URL= ALPACA_KEY_ID= ALPACA_SECRET_KEY= npm run start:tigerdata`. Gemini then uses its offline fallbacks and paper buys are simulated.

## How the old synchronous store keeps working
`server/store.js` still has a synchronous `get`/`set`, used for `feed`, `council`, `sentimentCache`, `thesis`, `thesisMatches`, `notifyLastSentDate` and `paperLedger`.

**In database mode:**
- At boot, every row of `kv_store` is loaded into memory.
- `set()` updates memory immediately and queues a durable upsert.
- A failed write is logged as `[store] ERROR…`, retried with backoff, and shown in `/api/health` (`storage.pendingWrites`, `storage.lastError`). It never falls back to JSON.
- On SIGTERM, Render's normal shutdown signal, pending writes are flushed.

**What the API reports as saved never goes through this path.** Sessions, theses and chat are written in awaited transactions: a route answers only after the database commits, and otherwise returns `503 storage_unavailable` with nothing half-saved.

## Schema (`server/persistence/migrations/001_init.sql`)
IDs are prefixed random UUIDs (`usr_`, `ses_`, `evt_`, `th_`, `art_`, `mat_`, `ntf_`, `conv_`, `msg_`). All times are `TIMESTAMPTZ` stored in UTC; the API returns ISO-8601, and the browser should display them in the user's timezone.

```
users ─┬─< onboarding_sessions ─< session_events        (what the user said/chose, when)
       │         │
       ├─< theses (session_id) ─┬─< thesis_article_checks >─┐   (article evaluated against thesis, when)
       │                        ├─< thesis_matches >────────┤── news_articles
       │                        │        │                  │   (assessment, assumption snapshot, when)
       │                        │        └─< notifications       (attempt + real outcome, idempotency key)
       ├─< chat_conversations ──┴─ (thesis_id, optional match_id) ─< chat_messages (seq, citations, meta)
kv_store                                                 (the legacy synchronous keys)
schema_migrations
```

| Table | Key points |
|---|---|
| `users` | demo identity and `preferences` JSONB |
| `onboarding_sessions` | engine state JSONB, `version` (compare-and-swap), `stage`, `next_actions` |
| `session_events` | one row per action: payload (message, symbols, edits), ok, error code, stage after |
| `theses` | full confirmed thesis JSONB (`data.id` = `thesis_id`), `selected_assets`, `assumptions` (text and challenge criteria), `assumption_version`, `monitoring_status` (`active` / `paused`), `origin`, `created_at` / `confirmed_at` / `source_confirmed_at` |
| `news_articles` | the original headline, summary, publisher, validated URL (http(s) only, otherwise null), `published_at`, `ingested_at`, `last_seen_at`, `seen_count`. Unique on ticker plus normalized headline, so a re-sent n8n batch never duplicates |
| `thesis_article_checks` | which articles were evaluated against which thesis version, when, and whether they matched |
| `thesis_matches` | `matchNewsDetailed` output per thesis + article + assumption version: stance, assessed stance, relevance, evidence quality, explanation, model, the full match JSONB, `assessed_at`. **History is kept**; only an "unanalyzed" placeholder is upgraded by a later real analysis |
| `notifications` | `idempotency_key` = `challenge_email:<thesis>:<article>`, `status` (`pending`, `sending`, `sent`, `failed`, `skipped`), `attempts`, `reason`, `sent_at` / `failed_at`, and the email fields minus the recipient |
| `chat_conversations` | `mode` (`general` / `investigation`); an investigation keeps its `match_id` forever |
| `chat_messages` | `seq` (unique per conversation), role, text, `citations`, `segments`, `meta` (source, model, fallback, follow-ups, evidence flags), `created_at` |

## API (`/api/v2`, `server/routes/v2.js`)
Every route except `POST /users` needs the header `X-User-Id`.

**`X-User-Id` is a demo identifier, not authentication.** Anyone who knows an id can use it. Another user's records always answer 404. Real login is post-hackathon work.

**The legacy demo user `usr_demo` can't be used here.** Its id is public (it's in the code), so every `/api/v2` route answers `403 reserved_user` for it. That way nobody can read the legacy thesis's evidence or chats, or pause its monitoring. The original single-thesis routes keep using it as before.

| Route | Purpose |
|---|---|
| `POST /users` `{displayName?, preferences?}` | create a user, returns `{userId,…}` |
| `GET /users/me` | the current user |
| `POST /thesis/session` `{sessionId?, action, payload, expectedVersion?}` | runs `handleThesisAction` as described in `docs/thesis-session-api.md`. The **stored** session is the only input. Saved with compare-and-swap; `409 version_conflict` on a stale version. Returns the engine response without `session`, plus `sessionId` (201 when a session is created) |
| `GET /thesis/sessions`, `GET /thesis/session/:id` | list and resume: stage, nextActions, displayText, history, profile, selection, draft |
| `POST /theses` `{sessionId}` | save the confirmed thesis from the stored session (201). Saving again returns the same thesis (200, `created:false`); unconfirmed gives 409 |
| `GET /theses`, `GET /theses/:id` | list and get (full thesis, assumptions, challenge criteria, timestamps) |
| `PATCH /theses/:id` `{monitoringStatus}` | `active` or `paused` (paused theses aren't matched or emailed) |
| `GET /theses/:id/matches` | evidence history, newest first, each with its saved article |
| `GET /theses/:id/notifications` | alert attempts and outcomes |
| `GET /theses/:id/timeline` | everything for the thesis in time order (see below) |
| `POST /theses/:id/chat` `{message, conversationId?, matchId?}` | runs `thesisChat` as described in `docs/thesis-chat-api.md`. A new conversation needs no `matchId` (general) or a `matchId` (investigation). The investigation's **original saved article and assessment are always E1**, however old. Both messages are saved in one transaction. Returns the chat result without `history`, plus `conversationId`, `userMessageId`, `assistantMessageId`, `askedAt`, `answeredAt` |
| `GET /theses/:id/conversations`, `GET /conversations/:id/messages` | reopen chats (messages include citations; an investigation includes its match and article) |

**Timeline event types:** `onboarding_started`, `session_action` (with what was typed or chosen), `assumptions_confirmed`, `thesis_saved`, `article_published`, `article_ingested`, `article_evaluated`, `evidence_assessed`, `notification_triggered`, `notification_sent`, `notification_failed`, `notification_skipped`, `chat_message`. Publication, ingestion, assessment, notification and chat times are separate fields.

## What existing routes do in database mode
- **`POST /api/webhook/seed`:**
  - It saves the articles (deduplicated) **before** it accepts the feed. If the database fails it returns `503` and nothing is stored, so n8n can retry.
  - The response is otherwise unchanged.
- **`POST /api/thesis`:**
  - The response is unchanged, and the thesis is also saved for the demo user `usr_demo`.
  - The new thesis becomes the monitored legacy thesis; the previous one is kept, paused.
  - If the database fails it returns `503` and the previous thesis keeps being served.
- **`GET /api/thesis` and `GET /api/thesis/news`:** unchanged. `/news` shows the legacy thesis's matches for the latest feed, in the original Contract C shape.
- **`GET /api/health`:** gains a `storage` field (`backend`, `relational`, `pendingWrites`, `lastError`).
- **The pipeline (after each seed):**
  - Uses the same news selection and the same unchanged `matchNewsDetailed`, but for **every active thesis**.
  - Each article is evaluated once per thesis assumption version. If the AI was unavailable, it is evaluated again on a later run.
  - Every assessment is kept.
- **Notifications:**
  - The `maybeNotify` contract and Contract E email are unchanged. Each challenge goes through a notification record:
  - **sent** only when `maybeNotify` returned `{sent:true}`, meaning the webhook answered 2xx.
  - **failed** on a delivery error. It is retried on later runs, up to 3 attempts, within 2 days, while the thesis is active.
  - **skipped** for final decisions: already sent today, webhook or recipient not configured.
  - **pending** again if a send was already in progress.
  - **Delivery uncertain: the webhook timed out.**
    - `notify.js` gives up after 8 seconds, but the request had already been sent, so n8n may still have emailed.
    - The record becomes `failed` with reason `delivery uncertain: …` and no attempts left. **It is never re-sent automatically**, to avoid a duplicate email.
    - Check the n8n execution log to see whether it went out.
  - **Delivery uncertain: the server stopped mid-send.** A crash, SIGKILL, or a shutdown that ran out of time leaves the row in `sending`. Rows idle for more than 10 minutes are recovered, with limits, at the next pipeline run:
    - If an email was recorded as sent that UTC day (the daily marker), it may have been this one: `failed`, not retried.
    - Otherwise the send most likely never completed: `failed` with **exactly one** more attempt. That attempt goes through the normal retry rules (3-attempt cap, 2-day window, active thesis, daily limit).
    - A send still in progress is never touched.
  - Reprocessing a batch never re-sends a sent alert, even after `reset-notify`.

## Shutdown (Render deploys and restarts)
`server/shutdown.js`. On SIGTERM or SIGINT the server does four things, in order:
1. Stops accepting connections.
2. Waits for every active request (for example a chat answer waiting on Gemini) and the running news pipeline. The wait is capped by `SHUTDOWN_TIMEOUT_MS`, default 25 seconds, because Render kills the process about 30 seconds after SIGTERM.
3. Flushes pending storage writes, for up to 4 seconds.
4. Closes the database connections.

If the wait runs out, the remaining connections are closed and the shutdown continues. Interrupted saves were transactions, so nothing is half-saved, and an interrupted email is recovered as described above.

## Tests never touch a real database
- **Every `scripts/test-*.js` loads `scripts/test-env.js` first.**
  - It blanks `LOOP_DB`, `DATABASE_URL`, `STORE_IMPORT_JSON` and `LOOP_PGLITE_DIR`. Because they're set to empty strings, dotenv can't refill them from `.env`, and servers the tests start inherit the blanks.
  - It sets `LOOP_TEST=1`. With that flag, `connectPostgres` refuses any host that isn't this machine, before any network activity.
- **`npm run test:isolation` runs first in `npm test`.** It shows that a shell plus a `.env` both saying `LOOP_DB=postgres` with a remote URL still end up on JSON storage: no connection, nothing printed. It also checks that every test script loads the helper.

## Commands
```
npm run test:persistence              # 26 offline tests (PGlite in-process; mock Gemini + stand-in email webhook)
npm run test:isolation                # tests can never reach a real database (runs first in npm test)
npm run test:shutdown                 # graceful shutdown: in-flight requests finish, then flush and close
npm test                              # every suite, persistence included
npm run demo:persistence              # end-to-end walkthrough on a throwaway PGlite database (hypothetical data)
npm run demo:persistence -- --use-database-url   # the same walkthrough against DATABASE_URL (writes hypothetical rows!)
LOOP_DB=postgres npm run db:migrate   # apply migrations to DATABASE_URL by hand
LOOP_DB=pglite npm start              # run the site locally on PGlite
```

## For Taha to review before merging
0. **Added in the TigerData integration pass:**
   - `PGSCHEMA` is now **required** with `LOOP_DB=postgres`. On Render, choose a schema such as `PGSCHEMA=thesis` (a fresh one) or `public`, and set it explicitly.
   - `PGSSLROOTCERT=certs/timescale-ca.pem` is needed for TigerData. `certs/timescale-ca.pem` is a public CA cert, safe to commit.
   - Citations gain `matchId` and `articleId` (additive).
   - New scripts: `scripts/db-inspect.js`, `server/persistence/checks.js`.
   - The demo's news step now goes through `POST /api/webhook/seed`.
1. **New dependencies:** `pg` (runtime) and `@electric-sql/pglite` (dev/test only; `LOOP_DB=pglite` needs it).
2. **`server/index.js` edits:**
   - `store.init()` before `listen`, and exit on storage failure
   - graceful shutdown: a request tracker as the first middleware, plus `server/shutdown.js` on SIGTERM/SIGINT
   - the `/api/v2` mount
   - the seed article save and the legacy thesis save (both only in database mode)
   - `storage` in `/api/health`
3. **`server/pipeline.js`:** a database-mode branch (`refreshPersisted`). The JSON path is untouched apart from one dispatch line.
4. **`server/store.js`:** the database write-through. The JSON path is identical.
5. **Render settings:**
   - `LOOP_DB=postgres` and `DATABASE_URL`, both in Render's environment, never committed
   - optionally `STORE_IMPORT_JSON=true` for the first boot
   - Before the demo, run `npm run db:migrate` once against TigerData, with approval.
6. **Accepted limits:**
   - **Cache keys are written in the background:** `feed`, `paperLedger`, `notifyLastSentDate`, `council`, `sentimentCache`, `thesis` and `thesisMatches`.
     - Their routes (seed, paper buy, legacy thesis) answer before the database has the write.
     - Normally the gap is milliseconds. **During a database outage it lasts until the database recovers.** The writes are kept in memory and retried, and shown in `/api/health` (`storage.pendingWrites`, `storage.lastError`).
     - If the process stops before the database is back, they're lost.
     - Sessions, theses and chat never go through this path.
   - **Email delivery can be uncertain** after a webhook timeout or a stop mid-send (see Notifications). Those emails are not re-sent, or re-sent once, rather than risking duplicates.
   - **One instance only:** each instance keeps its own in-memory cache, so don't run two Render instances at once.

## For Anne (website)
- **User id:** create one with `POST /api/v2/users` and keep the `userId`, for example in localStorage, sending it as `X-User-Id`. This is not a login.
- **Onboarding:** `POST /api/v2/thesis/session`. Keep only the `sessionId`, and resume with `GET /api/v2/thesis/session/:id`.
- **Saving:** `POST /api/v2/theses {sessionId}`. List saved theses with `GET /api/v2/theses`.
- **Chat:** `POST /api/v2/theses/:id/chat`, keeping `conversationId` per conversation. "Ask about this article" passes the item's `matchId` from `GET /api/v2/theses/:id/matches`.
- **Timestamps:** all ISO UTC; display them in the user's timezone.
