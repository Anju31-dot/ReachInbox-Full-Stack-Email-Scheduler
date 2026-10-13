# ReachInbox Email Scheduler

Full-stack email scheduler using React/Vite, Express/TypeScript, Prisma/PostgreSQL, BullMQ/Redis, optional Elasticsearch, Google OAuth, and Slack notifications.

## Requirements

- Node.js 22.12 or newer and npm
- Docker Desktop (recommended) or reachable PostgreSQL 16 and Redis 7 services
- Google OAuth client credentials for sign-in
- Ethereal SMTP credentials for actual test-message delivery
- Optional Slack OAuth app credentials for per-user hourly-limit notifications
- Optional Elasticsearch 8 endpoint

## Local setup

Copy `.env.example` to `backend/.env`, then configure values there. Do not commit either environment file. `backend/.env` is ignored by Git.
Replace the sample `JWT_SECRET` with a private random value of at least 32 characters (for example, generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`). It is used to derive the encryption key for stored Slack OAuth tokens, so keep it stable or reconnect Slack after rotation.

With Docker Desktop running, start the dependencies from the project root:

```powershell
docker compose up -d postgres redis elasticsearch
```

Install dependencies and create/update the local database schema:

```powershell
npm --prefix .\backend install
npm --prefix .\backend run prisma:generate
npm --prefix .\frontend install
```

For a **new/empty database**, run `npm --prefix .\backend run prisma:migrate:deploy`.
For a database already created with Prisma `db push` (including the supplied existing database), run `npm --prefix .\backend run prisma:push` and then `npm --prefix .\backend run prisma:migrate:baseline` once. This synchronizes the schema before recording the initial migration as the baseline; do not baseline an empty database.

Run the API/worker and frontend in separate terminals:

```powershell
npm run dev:backend
```

```powershell
npm run dev:frontend
```

Open <http://localhost:5173>. The API health endpoint is <http://localhost:5000/api/health>. Once signed in, the Bull Board queue view is at <http://localhost:5000/admin/queues>.

If Docker is unavailable on Windows, use PostgreSQL and Redis running inside the same WSL distribution as Node, or install native Windows services. `localhost` in Windows and WSL may resolve to different service networks; running the app and services in one environment avoids that mismatch. Configure `DATABASE_URL`, `REDIS_HOST`, and `REDIS_PORT` for the environment where Node actually runs.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT`, `FRONTEND_URL`, `NODE_ENV` | API port, allowed browser origin, and production cookie behavior |
| `DATABASE_URL` | PostgreSQL connection URL |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | BullMQ and short-lived OAuth/rate-limit state |
| `JWT_SECRET` | Random secret of at least 32 characters; signs sessions and derives the encryption key for stored Slack OAuth tokens. Keep stable or reconnect Slack after rotation. |
| `QUEUE_DASHBOARD_ADMIN_EMAILS` | Comma-separated Google account emails allowed to access Bull Board; leave empty to disable dashboard access |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` | Google OAuth web application credentials and exact callback URL |
| `ETHEREAL_USER`, `ETHEREAL_PASS` | Ethereal SMTP account for test delivery |
| `WORKER_CONCURRENCY` | BullMQ worker concurrency |
| `MIN_SEND_DELAY_SECONDS`, `MAX_HOURLY_RATE_PER_SENDER` | Redis-coordinated per-sender pacing and hourly limit |
| `ELASTICSEARCH_NODE`, `ELASTICSEARCH_USERNAME`, `ELASTICSEARCH_PASSWORD`, `ELASTICSEARCH_INDEX` | Optional email indexing and search |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URI` | Slack OAuth app. Request the `chat:write` bot scope. |
| `SLACK_WEBHOOK_URL` | Optional global webhook fallback when a user has not connected Slack |
| `SLACK_NOTIFICATION_CHANNEL` | Optional destination for the legacy bot-token fallback |

Google Cloud Console must allow the callback URL configured in `GOOGLE_CALLBACK_URL` (default `http://localhost:5000/api/auth/google/callback`). Slack must allow the URL in `SLACK_REDIRECT_URI` (default `http://localhost:5000/api/slack/callback`). For a local Slack notification, connect a workspace in the UI, invite its bot to a channel, and save that channel's ID. The bot token is encrypted in PostgreSQL; OAuth state is single-use and stored in Redis.

To obtain Ethereal credentials, create a test account at <https://ethereal.email/create>, then set the generated SMTP username and password as `ETHEREAL_USER` and `ETHEREAL_PASS` in `backend/.env`. The worker marks messages failed when credentials are absent; a `SENT` status is only recorded after SMTP accepts the message. Ethereal messages are test mail and do not reach real inboxes.

## Queue and delivery behavior

- BullMQ delayed jobs are the scheduler; there is no cron-based scheduler.
- Email rows are tenant-owned and idempotent per user. Jobs are deduplicated by their database ID.
- Hourly rate and minimum-spacing reservations are atomic in Redis and keyed by sender. Rate-limited jobs are moved back to BullMQ's delayed set instead of discarded.
- Scheduled rows are re-enqueued at startup. A row left `SENDING` after a crash is marked failed with an uncertain-outcome error rather than resent, avoiding possible duplicate delivery.
- An hourly-limit Slack alert is sent once per sender and user per hour when that user has configured a Slack channel. Missing/disconnected Slack does not block email processing.
- Email APIs require a Google-authenticated session and are scoped to the signed-in user. Sessions use opaque, HttpOnly, SameSite=Lax cookies stored/revocable in Redis; mutating endpoints reject cross-origin browser requests. Bull Board is additionally limited to addresses listed in `QUEUE_DASHBOARD_ADMIN_EMAILS`.
- Elasticsearch is optional. Search falls back to tenant-scoped PostgreSQL search if Elasticsearch is unavailable.

## Checks

```powershell
npm --prefix .\backend run lint
npm --prefix .\backend run build
npm --prefix .\backend test
npm --prefix .\frontend run build
```

## Production deployment

| Component | Host | Root directory | Build | Start / output |
| --- | --- | --- | --- | --- |
| API | Render Web Service | `backend` | `npm install && npm run build` | `npm start` — health check `/api/health` |
| Queue worker | Render Background Worker | `backend` | same as API | `npm run start:worker` with `ENABLE_HTTP=false`, `ENABLE_WORKER=true` |
| PostgreSQL | Render PostgreSQL (or other managed Postgres) | — | — | set `DATABASE_URL` |
| Redis | Render Key Value or other Redis-compatible service | — | — | set `REDIS_URL` (preferred) or `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` |
| Frontend | Vercel | `frontend` | `npm run build` | output `dist` |

Run `npx prisma migrate deploy` once against production Postgres (Render **Pre-Deploy Command** on the API service, or a one-off shell). Do not reset the database.

Set on the API and worker: `NODE_ENV=production`, `FRONTEND_URL=https://<your-vercel-domain>`, `JWT_SECRET` (≥32 chars, identical on API and worker), Google OAuth vars, optional Ethereal/Slack/Elasticsearch. On the API only: `ENABLE_WORKER=false`. On the worker: `ENABLE_HTTP=false`.

Set on Vercel: `VITE_API_URL=https://<your-render-api-domain>` (no trailing slash). Redeploy the frontend after changing it.

Google Cloud Console: add authorized redirect URI `https://<render-api>/api/auth/google/callback` and authorized JavaScript origin `https://<vercel-domain>`. Slack app: set redirect URL `https://<render-api>/api/slack/callback`.

Optional: apply `render.yaml` from the repo root via Render Blueprint for Postgres, Redis, API, and worker.

## GitHub submission checklist

1. Keep `backend/.env` local; commit `.env.example`, source, schema, and migrations only.
2. Set real Google and Ethereal credentials locally before trying OAuth or delivery.
3. Run the checks above and inspect `git status` before committing.
4. Do not submit live OAuth tokens, SMTP credentials, database passwords, or generated `node_modules`/`dist` directories.
