# ReachInbox Email Scheduler — Implementation Plan

## 1. Scope and current state

The repository is currently greenfield and contains only `ASSIGNMENT.md`. This plan covers the required production-style scheduler and dashboard without implementing application code yet.

The target repository layout is:

```text
.
├── apps/
│   ├── backend/
│   │   ├── prisma/
│   │   ├── src/
│   │   │   ├── api/
│   │   │   ├── auth/
│   │   │   ├── config/
│   │   │   ├── db/
│   │   │   ├── email/
│   │   │   ├── queue/
│   │   │   ├── rate-limit/
│   │   │   ├── worker/
│   │   │   ├── app.ts
│   │   │   ├── server.ts
│   │   │   └── worker.ts
│   │   └── tests/
│   └── frontend/
│       ├── src/
│       │   ├── api/
│       │   ├── components/
│       │   ├── features/
│       │   ├── hooks/
│       │   ├── pages/
│       │   ├── routes/
│       │   └── types/
│       └── tests/
├── docker-compose.yml
├── .env.example
├── package.json
├── README.md
├── AGENTS.md
└── IMPLEMENTATION_PLAN.md
```

The root will use npm workspaces for `apps/*`. The backend package will expose separate API and worker entry points so they can be restarted and scaled independently.

## 2. Proposed architecture

```text
Browser (React/Vite/Tailwind)
  │
  │ HTTPS + secure session cookie
  ▼
Express API ───────────────► Google OAuth 2.0 / OpenID Connect
  │
  ├──► PostgreSQL + Prisma
  │      users, senders, batches, email state, attempts
  │
  └──► BullMQ Queue in Redis
           delayed job per recipient
                    │
                    ▼
             BullMQ Worker(s)
                    │
                    ├──► atomic per-sender Redis admission gate
                    │      hourly quota + minimum-send spacing
                    ├──► PostgreSQL claim/idempotency checks
                    └──► Nodemailer ──► Ethereal SMTP
```

Key boundaries:

- PostgreSQL is the source of truth for whether an email is scheduled, processing, sent, failed, or delivery-unknown.
- BullMQ delayed jobs are the execution mechanism, not the business record. Queue state may be reconstructed from PostgreSQL.
- Redis is durable in local Docker through a named volume and AOF. It stores BullMQ data, sessions, and atomic rate-limit state.
- The API never sends email. A separately runnable worker is the only SMTP caller.
- All timestamps are stored in UTC and rendered in the browser's local timezone.
- Configuration is parsed and validated once at process startup. Missing or invalid configuration fails fast.

## 3. Technology choices

### Frontend

- React, Vite, and strict TypeScript.
- Tailwind CSS for layout and design tokens.
- React Router for login/callback/dashboard routing.
- TanStack Query for server state, caching, polling, loading, and error states.
- React Hook Form plus Zod for compose validation.
- A small toast component and reusable primitives for buttons, inputs, dialogs, tabs, badges, pagination, skeletons, and tables.
- Papa Parse or a similarly focused parser for the client-side CSV preview; the backend independently parses and validates the uploaded file and is authoritative.

### Backend

- Express with strict TypeScript and centralized async error handling.
- Zod schemas for environment variables, params, queries, JSON bodies, and multipart fields.
- Prisma with PostgreSQL and checked-in migrations.
- BullMQ for one delayed job per email recipient.
- Nodemailer with an explicitly configured Ethereal SMTP account.
- Passport Google OAuth 2.0, or the Google OAuth client directly, using the authorization-code flow and only `openid`, `email`, and `profile` scopes.
- Redis-backed server sessions rather than putting OAuth identity data in local storage.
- Structured logs with request, batch, email, job, sender, and attempt identifiers; secrets and email bodies are redacted.

### Infrastructure

- Docker Compose services for PostgreSQL and Redis only; application processes remain easy to run locally for the demonstration.
- PostgreSQL and Redis use named volumes and health checks.
- Redis enables append-only persistence. PostgreSQL data remains in its volume.
- Every host/container port, credential, limit, delay, queue name, and secret comes from validated environment configuration.

## 4. Database models

The exact Prisma names may be refined during implementation, but the persisted concepts and constraints will be as follows.

### `User`

- `id` UUID primary key.
- `googleSubject` unique Google `sub` identifier.
- `email` unique, normalized email.
- `name`, `avatarUrl`.
- `createdAt`, `updatedAt`, `lastLoginAt`.
- Relations to senders and batches.

Google access/refresh tokens are not required because the application only authenticates identity and sends through Ethereal. If token storage becomes necessary, tokens must be encrypted at rest and never logged.

### `EmailSender`

- `id` UUID primary key and `userId` foreign key.
- `displayName`, `email`, `isDefault`, `isActive`.
- `hourlyLimit` and `minimumDelayMs` as the current operational sender policy.
- `createdAt`, `updatedAt`.
- Unique normalized sender email per user.

Multiple logical sender identities use the configured Ethereal transport. The compose form selects a sender. The schedule request's hourly limit and delay atomically update that sender's policy and are copied to the batch for audit. Existing pending jobs use the sender's current policy at execution time, so concurrent batches cannot bypass a per-sender cap by supplying different limits.

### `EmailBatch`

- `id` UUID primary key and `userId`/`senderId` foreign keys.
- `idempotencyKey`, unique with `userId`.
- `subject`, `bodyText`.
- `startAt`.
- `requestedHourlyLimit`, `requestedMinimumDelayMs` policy snapshot.
- `sourceFilename`, `totalRows`, `validRecipientCount`, `invalidRecipientCount`, `duplicateRecipientCount`.
- `status`: `CREATING`, `SCHEDULED`, `PARTIALLY_FAILED`, `COMPLETED`.
- `createdAt`, `updatedAt`.

### `ScheduledEmail`

- `id` UUID primary key and `batchId`/`senderId` foreign keys.
- `recipientEmail`, `normalizedRecipientEmail`, `sequenceNumber`.
- `scheduledAt`, `nextAttemptAt`, `sentAt`.
- `status`: `SCHEDULED`, `RATE_LIMITED`, `PROCESSING`, `RETRYABLE`, `SENT`, `FAILED`, `DELIVERY_UNKNOWN`, `CANCELLED`.
- `bullJobId` unique and deterministic: `email_<ScheduledEmail UUID>`; no colon is used.
- `idempotencyKey` unique, derived from batch and normalized recipient.
- `attemptCount`, `processingToken`, `processingStartedAt`.
- `smtpMessageId`, `etherealPreviewUrl` where available.
- `lastErrorCode`, `lastErrorMessage`, `rateLimitedUntil`.
- `createdAt`, `updatedAt`.
- Unique `(batchId, normalizedRecipientEmail)` to remove duplicate leads within one upload.
- Indexes on `(batchId, sequenceNumber)`, `(senderId, status, scheduledAt)`, `(status, nextAttemptAt)`, and `(sentAt)` for queue recovery and dashboard pagination.

### `SendAttempt`

- `id` UUID primary key and `scheduledEmailId` foreign key.
- `attemptNumber`, `attemptToken` unique.
- `startedAt`, `finishedAt`.
- `outcome`: `CLAIMED`, `RATE_LIMITED`, `SMTP_ACCEPTED`, `DEFINITE_FAILURE`, `TRANSIENT_FAILURE`, `DELIVERY_UNKNOWN`.
- Sanitized SMTP response metadata and error classification; no credentials or full message body.

This table supplies an audit trail and helps reconstruct current-hour usage after Redis data loss.

### Sessions

Express sessions live in Redis with an opaque cookie identifier. They are not a Prisma model. Session keys use an application-specific prefix and TTL.

## 5. API surface

All application routes are under `/api`, JSON unless identified as multipart, authenticated unless explicitly public, and return a consistent error envelope with a request ID.

### Health and configuration

- `GET /api/health/live` — process liveness; no dependency details.
- `GET /api/health/ready` — verifies PostgreSQL and Redis connectivity.
- `GET /api/config/compose` — authenticated bounds/defaults for lead count, file size, delay, and hourly limits so the frontend does not hardcode them.

### Authentication

- `GET /api/auth/google` — creates OAuth state and starts the real Google authorization-code flow.
- `GET /api/auth/google/callback` — validates state/code, upserts the user, creates the Redis session, and redirects to the configured frontend URL.
- `GET /api/auth/me` — returns `id`, name, email, and avatar.
- `POST /api/auth/logout` — destroys the Redis session and clears the cookie.

The cookie is HTTP-only, secure in production, SameSite=Lax, and uses a configured name/domain/TTL. CORS uses an exact configured frontend origin with credentials. State validation, session regeneration, Helmet, request-size limits, and auth-route rate limiting protect the flow.

### Senders

- `GET /api/senders` — lists the signed-in user's active sender identities and current policies.
- `POST /api/senders` — adds a logical Ethereal sender identity after validation.
- `PATCH /api/senders/:senderId` — updates name/default/active state and validated policy settings.

On first login, a default sender profile may be created from the verified Google profile, but authentication remains separate from SMTP delivery.

### Scheduling and dashboard

- `POST /api/email-batches` — multipart request with `leadsFile`, `senderId`, `subject`, `body`, `startAt`, `minimumDelayMs`, and `hourlyLimit`; requires an `Idempotency-Key` header.
- `GET /api/email-batches/:batchId` — batch counts and progress.
- `GET /api/emails/scheduled?cursor=&limit=&senderId=` — paginated future/in-progress rows with recipient, subject, effective next time, and status.
- `GET /api/emails/sent?cursor=&limit=&senderId=` — paginated terminal rows with recipient, subject, sent/failure time, and `sent`, `failed`, or `delivery_unknown` status.

Authorization filters every query by the authenticated user's ownership. Cursor pagination avoids large offset costs as tables grow.

## 6. Lead upload and validation

The frontend accepts `.csv` and `.txt` files, parses a preview, reports detected/valid/duplicate/invalid counts, and blocks obvious errors before upload. CSV supports a case-insensitive `email` header or a single-column file. Text supports one address per line and optionally comma-separated values.

The backend repeats all validation because client checks are not a trust boundary:

1. Enforce configured MIME/extension, byte-size, row-count, subject/body, delay, limit, sender ownership, and start-time bounds.
2. Stream or incrementally parse input rather than loading an unbounded file into memory.
3. Trim whitespace, strip a UTF-8 BOM, normalize the domain portion, reject malformed/control-character addresses, and deduplicate within the batch.
4. Reject a file with zero valid addresses. For mixed files, accept valid rows and return bounded invalid-row details plus complete counts.
5. Escape all displayed values; email bodies are plain text for the assignment unless a future sanitized HTML requirement is approved.

The database unique constraint remains the final defense against duplicate rows even if parser logic regresses.

## 7. Scheduling transaction and queue lifecycle

### Creation

1. The API validates auth, idempotency header, multipart fields, sender, and leads.
2. In a PostgreSQL transaction it locks/updates the sender policy, creates the batch, and bulk-inserts one `ScheduledEmail` per unique valid recipient.
3. Initial `scheduledAt` is `startAt + sequenceNumber × minimumDelayMs`. This spreads a batch before it reaches the worker but does not replace runtime enforcement.
4. The transaction commits before Redis is touched, preventing queue jobs that have no database record.
5. The API enqueues jobs in configurable chunks through BullMQ `addBulk`, with delay computed from the current time and deterministic `bullJobId` values.
6. A repeated request with the same user/idempotency key returns the existing batch instead of creating or enqueueing duplicates.

If the process dies after the database commit but before all jobs are added, startup reconciliation fills the gap.

### Normal job lifecycle

```text
DB SCHEDULED + BullMQ delayed
          │ due
          ▼
Worker loads DB row and checks terminal state
          │
          ├── terminal/processing elsewhere ──► no send; complete or re-delay
          │
          ▼
Atomic Redis sender admission
          │
          ├── not yet allowed ──► DB RATE_LIMITED + BullMQ moveToDelayed
          │
          ▼
PostgreSQL claim: PROCESSING + unique attempt token
          │
          ▼
Nodemailer/Ethereal send with deterministic Message-ID
          │
          ├── accepted ──► DB SENT, SMTP metadata, preview URL
          ├── definite permanent error ──► DB FAILED
          └── definite transient error ──► DB RETRYABLE + BullMQ backoff
```

Moving an active job back to delayed state will use BullMQ's supported `moveToDelayed`/`DelayedError` worker pattern so it is not also marked complete or failed. Rate-limit deferrals do not consume normal failure attempts.

### Restart and reconciliation

- Redis AOF and its Docker volume retain delayed jobs across ordinary API/worker/Redis restarts.
- PostgreSQL retains every business record independently.
- Before a worker begins consuming, a bounded, paginated startup reconciler queries nonterminal rows and calls `addBulk` with deterministic job IDs. Existing BullMQ jobs are naturally deduplicated.
- Rows whose requested time passed while the worker was down are queued with zero delay and still pass through the sender gate.
- Stale `PROCESSING` rows are not blindly resent. They become `DELIVERY_UNKNOWN` if SMTP acceptance cannot be proven, preventing an automatic duplicate after the crash boundary.
- Completed BullMQ jobs are retained for a configured period/count so their deterministic IDs continue to guard against accidental re-enqueueing; PostgreSQL terminal-state checks remain permanent.
- Graceful shutdown stops accepting HTTP traffic, closes the HTTP server, pauses/closes workers after current jobs, then disconnects Prisma and Redis.

No cron, cron library, repeatable BullMQ job, or periodic wall-clock scheduler is used. Reconciliation runs on process startup and can also be invoked explicitly by an administrative CLI during recovery.

## 8. Redis-backed per-sender rate limiting

### Atomic admission gate

A versioned Lua script executes atomically in Redis for each due job. Redis Cluster hash tags keep a sender's keys colocated if clustering is introduced. Relevant keys are conceptually:

- `email-rate:v1:{senderId}:hour:<UTC-window-start>` — admitted count with expiry beyond the window.
- `email-rate:v1:{senderId}:next` — earliest timestamp at which another send may start.
- `email-rate:v1:{senderId}:reservation:<scheduledEmailId>` — idempotent admission marker.

Inputs are current server time, sender hourly limit, minimum delay, email ID, and a configured key TTL. The script:

1. Returns the existing reservation for the same email without incrementing twice.
2. Computes the fixed UTC hour window.
3. If the count reached the limit, returns the next hour boundary as the earliest retry time.
4. If the sender spacing timestamp is still in the future, returns that timestamp.
5. Otherwise creates the email reservation, increments the hour count, advances the sender's next-send timestamp, sets expirations, and admits the job.

This protects the aggregate sender rate across concurrent jobs, worker threads, and worker processes. Worker concurrency controls throughput across senders; it cannot violate one sender's policy.

### Rescheduling and ordering

- A rejected job is moved back to BullMQ delayed state at the returned timestamp and recorded as `RATE_LIMITED`; it is never dropped or permanently failed.
- Initial jobs have distinct schedule times based on file order. Deferred jobs retain `sequenceNumber`, and a small configured ordering offset may be applied when many jobs share the next hour boundary.
- Ordering is guaranteed within initial batch construction and preserved best-effort across rate-limit waves. Strict global FIFO across independent batches is not promised because parallel workers and SMTP latency can reorder completion.
- At the next window, workers admit only available quota; overflow is delayed again. This bounds load rather than creating a busy loop.

### Persistence and recovery of counters

- Redis AOF normally preserves counters and reservations across restarts.
- Worker startup acquires a per-sender bootstrap lock before consumption and seeds missing current-window count/last-send time from PostgreSQL `SendAttempt`/`ScheduledEmail` records. Other workers wait or re-delay during bootstrap.
- Reservations are conservative: a claimed slot may remain consumed after a definite failure or crash. This can reduce throughput for one hour but will never exceed the configured limit.

## 9. Idempotency and duplicate-send prevention

Duplicate defense is layered:

1. API requests require a caller-supplied `Idempotency-Key`, unique per user.
2. Duplicate recipients inside a batch are normalized and rejected by a database unique constraint.
3. Every email has one deterministic BullMQ job ID, and bulk/startup enqueueing can safely repeat.
4. The worker always reads PostgreSQL first and exits for `SENT`, `FAILED`, `DELIVERY_UNKNOWN`, or `CANCELLED` rows.
5. A conditional database update claims only an eligible row and writes a unique processing/attempt token.
6. Redis admission reservations are keyed by email ID, so BullMQ retries do not consume hourly quota twice.
7. Nodemailer uses a deterministic RFC Message-ID derived from the scheduled-email ID for traceability.

SMTP does not offer a transactional, idempotency-key API. There is an unavoidable crash window after the SMTP server accepts a message but before PostgreSQL records `SENT`. Automatically retrying that ambiguous attempt could duplicate mail; marking it sent before SMTP could lose mail. This design chooses duplicate prevention: stale ambiguous attempts become `DELIVERY_UNKNOWN` and are not automatically resent. The README and dashboard will disclose this at-most-once trade-off. Definite pre-acceptance transient failures remain safe to retry.

## 10. Handling 1,000+ simultaneous emails

- Parse inputs incrementally with configured byte and lead caps.
- Use Prisma bulk insertion and BullMQ `addBulk` in configurable chunks instead of one database/Redis round trip per lead.
- Return a batch summary rather than 1,000 full email objects.
- Use database cursor pagination and indexed dashboard queries.
- Pre-space scheduled times, then enforce actual per-sender spacing and hourly quota atomically at runtime.
- Run configurable worker concurrency, with horizontal workers safe because all claims and limits use PostgreSQL/Redis atomic operations.
- Keep job payloads small: only `scheduledEmailId` and schema version. Subject/body/recipient are loaded from PostgreSQL, avoiding Redis duplication of message bodies.
- Apply bounded SMTP timeouts, bounded exponential retry/backoff for definite transient failures, and configured job retention.
- Test load with an injected fake transport rather than sending 1,000 messages through Ethereal.

Expected behavior is controlled backlog growth. For example, if 1,000 emails share one sender whose configured limit is 200/hour, at most 200 reservations are admitted in each UTC hour and the rest remain delayed. Multiple senders can use worker concurrency in parallel while preserving their independent caps.

## 11. Frontend experience

### Authentication and shell

- Public login page with a real “Continue with Google” action that navigates to the backend OAuth route.
- Protected dashboard route waits for `/auth/me`; unauthenticated responses return to login.
- Header shows Google name, email, avatar with safe fallback, and logout.
- Responsive layout, accessible focus states, keyboard-operable modal/tabs, semantic labels, and mobile table overflow.

### Dashboard

- `Scheduled Emails` and `Sent Emails` tabs reflected in the URL.
- Compose primary action.
- Scheduled columns: email, subject, effective scheduled/next-at time, status.
- Sent columns: email, subject, sent/failure time, status. `DELIVERY_UNKNOWN` is visually distinct and explained.
- Cursor pagination, configured refetch interval, manual refresh, skeleton loading, retryable error state, and purpose-built empty states.

### Compose

- Sender selector plus subject and plain-text body.
- CSV/text drag-and-drop or file picker with parsed counts and bounded invalid-row preview.
- Local datetime input with explicit timezone explanation; converted to ISO UTC for the API.
- Delay and hourly-limit inputs populated from backend configuration/sender policy, with units and validated ranges.
- Review summary before scheduling, submit progress, double-submit protection, and success link to the created batch.
- The backend response replaces preliminary client counts with authoritative accepted/invalid/duplicate totals.

The assignment's `Figma Link` section contains no URL. Component structure and tokens will make visual alignment straightforward, but exact Figma matching requires the missing link or exported screens.

## 12. Environment contract

`.env.example` will contain safe placeholders and comments, never working credentials. The validated contract will include categories for:

- Runtime and URLs: node environment, backend host/port, frontend URL, API base URL, trusted proxy setting.
- PostgreSQL: user, password placeholder, database, host/port, and assembled `DATABASE_URL`.
- Redis: host/port, password placeholder, TLS flag/URL, BullMQ prefix, queue name, and persistence-related settings.
- Auth/session: Google client ID/secret placeholders, exact callback URL, session secret placeholder, cookie name/domain/TTL.
- SMTP: Ethereal host/port/secure flag, user/password placeholders, connection/socket timeouts, default sender name/address.
- Worker policy: concurrency, default/min/max sender delay, default/max hourly limit, SMTP attempts/backoff, processing lease, job retention, reconciliation chunk size, Redis reservation TTL.
- Upload/API/UI: maximum file bytes/leads/subject/body, allowed start horizon, page size, dashboard refresh interval, logging level.

Both backend entry points share the same config schema. Frontend variables use Vite's public prefix and contain no secrets.

## 13. Testing strategy

### Unit tests

- Environment schema and redaction.
- CSV/text parsing, normalization, invalid rows, duplicate rows, and upload limits.
- Schedule-time calculation and UTC conversion.
- Error classification and status transitions.
- Deterministic API idempotency and BullMQ job ID generation.
- Frontend form schemas, auth guards, counts, states, and table formatting.

### Integration tests

- Express routes with Supertest, real PostgreSQL/Redis test services, and an authenticated test-only session helper.
- Prisma ownership/unique constraints and batch transaction rollback.
- BullMQ delayed execution, `addBulk`, startup reconciliation, and restart behavior.
- Atomic Lua admission with concurrent workers: spacing, exactly the configured hourly admissions, idempotent reservations, next-hour deferral, and independent senders.
- Worker claims with mocked Nodemailer: sent, definite failure, transient retry, stale processing, and duplicate job delivery.
- A 1,000-lead batch using a fake SMTP transport, asserting no loss, duplicate, in-memory counting, or quota violation.

### Frontend and end-to-end tests

- Vitest, React Testing Library, and MSW for login state, compose validation/upload, loading/empty/error/success tables, pagination, and logout.
- Playwright for the dashboard workflow using a test-only authenticated fixture; the five-minute manual demo verifies real Google OAuth.
- Accessibility smoke checks on login, compose modal, tabs, and tables.

## 14. Development phases and verification gates

No phase begins until the preceding phase's verification criteria pass.

### Phase 0 — Inputs and decisions

Deliverables: confirm Figma assets, Google OAuth origins/callback, local port choices through env, and Ethereal account approach.

Verification:

- Missing inputs are recorded without secrets in source or chat.
- Architecture, security trade-offs, and this plan are approved.

### Phase 1 — Monorepo and quality baseline

Deliverables: npm workspaces, strict shared TypeScript conventions, backend/frontend scaffolds, ESLint/Prettier, root scripts, `.gitignore`, and `.env.example`.

Verification:

- Clean install succeeds.
- Both packages type-check, lint, test, and build from root commands.
- No secrets or `.env` file are tracked.

### Phase 2 — PostgreSQL, Redis, Prisma, and configuration

Deliverables: Docker Compose, health checks/volumes/AOF, validated configuration, Prisma schema/migration, connection modules, health routes.

Verification:

- Fresh Docker volumes become healthy and migration succeeds.
- Readiness fails when either dependency is unavailable and recovers when restored.
- Data survives container restarts.
- Prisma schema constraints and configuration tests pass.

### Phase 3 — Real Google authentication

Deliverables: OAuth start/callback, Redis session store, user upsert, `/auth/me`, logout, security middleware, protected route helper.

Verification:

- A real Google account logs in and returns name/email/avatar.
- Invalid state/callback is rejected.
- Protected APIs reject anonymous users.
- Logout invalidates the server-side session; no OAuth secret/token reaches the browser.

### Phase 4 — Sender, upload, and scheduling API

Deliverables: sender APIs, multipart parser, validation, batch transaction, bulk rows, idempotent response, and paginated read routes.

Verification:

- CSV/text valid, mixed, empty, oversized, malformed, and duplicate cases behave as documented.
- Repeating an idempotency key creates no additional batch/email rows.
- Cross-user sender/batch access is rejected.
- A 1,000-recipient request inserts exactly the valid unique count efficiently.

### Phase 5 — BullMQ delayed queue and recovery

Deliverables: queue factory, chunked `addBulk`, deterministic IDs, separate worker entry point, status transitions, graceful shutdown, startup reconciliation.

Verification:

- A future job remains delayed and is processed only when due.
- Duplicate enqueue attempts result in one logical job/send claim.
- Restarting API and worker before due time does not lose or reset a job.
- Simulated commit/enqueue interruption is repaired at startup.
- No cron or cron library exists in dependencies or source.

### Phase 6 — Rate limiter, concurrency, and SMTP

Deliverables: configurable worker concurrency, atomic Redis sender gate, delayed rescheduling, Nodemailer/Ethereal transport, retry classification, attempt audit.

Verification:

- Concurrent workers cannot exceed per-sender hourly quota or spacing.
- Different senders can progress concurrently.
- Quota overflow is delayed into a later window without failure/drop.
- Rate-limit deferral does not consume failure retries.
- A real Ethereal message is accepted and its preview URL is stored.
- Stale ambiguous processing is never automatically duplicated.

### Phase 7 — React dashboard

Deliverables: login, protected shell/header, compose experience, scheduled/sent tabs, reusable UI, responsive Tailwind styling, loading/empty/error/toast states.

Verification:

- Real login redirects to the dashboard and header data is correct.
- Compose reports lead counts and sends the validated multipart request once.
- New jobs appear scheduled, then move to sent/failed without a full reload.
- Empty, loading, API error, pagination, mobile, keyboard, and logout flows work.
- UI is reconciled to Figma once the missing design link is supplied.

### Phase 8 — Reliability and load proof

Deliverables: 1,000-job integration scenario, multi-worker tests, restart script/checklist, logging and error-path hardening.

Verification:

- Accepted database row count equals terminal plus genuinely pending rows.
- No email has more than one SMTP acceptance attempt.
- Per-sender hourly and spacing assertions hold under parallel workers.
- PostgreSQL-only recovery can reconstruct missing nonterminal queue jobs.
- Type-check, lint, unit, integration, frontend, and build commands all pass.

### Phase 9 — Documentation and five-minute demonstration

Deliverables: final README, setup/troubleshooting, architecture, env/Ethereal/Google instructions, features matrix, trade-offs, test commands, demo checklist.

Verification:

- A clean clone can be run solely from README instructions and local secrets.
- README explicitly explains delayed jobs, restart persistence, concurrency, atomic rate limiting, rescheduling, idempotency, and SMTP uncertainty.
- Final repository scan finds no credential, tracked `.env`, cron dependency, hardcoded operational limit, or secret in logs.
- The rehearsed demonstration stays under five minutes.

## 15. README and five-minute demonstration procedure

The README will include prerequisites, exact root/package commands, Docker startup, migrations, Google Console setup, Ethereal account setup, environment reference, architecture diagram, data/queue lifecycle, testing, assumptions, and troubleshooting.

Proposed demonstration timeline:

1. **0:00–0:40** — Show healthy PostgreSQL/Redis, start API/worker/frontend, and sign in with real Google OAuth.
2. **0:40–1:30** — Compose a batch from a small CSV/text file; point out detected leads, sender, future start, delay, and a deliberately low hourly cap.
3. **1:30–2:20** — Show rows in Scheduled Emails, then watch due rows move to Sent Emails and open one Ethereal preview.
4. **2:20–3:25** — Schedule a future batch, stop API and worker, restart them, and show the same database rows/jobs send at the intended time rather than being recreated.
5. **3:25–4:25** — Use a prepared small load case to show parallel workers, minimum spacing, and over-limit rows moving to the next available hour instead of failing.
6. **4:25–5:00** — Show tests/build passing and summarize PostgreSQL source of truth, deterministic IDs, Redis atomic gate, and the documented SMTP crash trade-off.

The load portion will use safe demonstration-sized counts; automated tests prove the 1,000-job behavior without flooding Ethereal.

## 16. Required user-provided information and credentials

### Blocking before visual implementation

- The Figma URL or exported reference screens. `ASSIGNMENT.md` has a `Figma Link` heading but no actual link, so exact visual matching cannot be verified without it.

### Required before real authentication/demo

- A Google Cloud OAuth 2.0 Web Application client configured with the agreed local/production authorized JavaScript origin and exact backend callback URL.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, stored only in the local `.env`/deployment secret store.
- Confirmation of the local frontend and backend URLs to register in Google Cloud; configurable defaults will be documented but not embedded as secrets.

### Required before real Ethereal delivery/demo

- A stable Ethereal test account's SMTP host, port, username, and password, stored only in `.env`/the deployment secret store. It can be created directly through Ethereal or via a documented local setup helper.
- The logical sender names/addresses desired for the demo, or approval to create them through the sender API after login.

Do not paste any client secret, session secret, SMTP password, database password, or Redis password into source files, committed configuration, screenshots, demo recordings, or issue/PR text. `.env.example` will contain placeholders only.

### Submission-only actions

- The private GitHub repository must grant access to the assignment's named reviewers, `Mitrajit` and `Yadav036`.
- The final repository and maximum-five-minute video links must be submitted through the form in `ASSIGNMENT.md` by the owner. These external actions will not be performed without explicit approval.
