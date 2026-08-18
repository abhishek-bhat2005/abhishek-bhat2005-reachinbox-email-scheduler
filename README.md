# ReachInbox Email Scheduler

A full-stack email scheduling assignment built as an npm-workspace monorepo.

The implementation is in progress and follows [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md). Application code lives in `apps/backend` and `apps/frontend`.

## Current foundation

- `apps/backend`: Express, strict TypeScript, Prisma/PostgreSQL, and Redis connectivity.
- `apps/frontend`: React, Vite, strict TypeScript, and Tailwind CSS.
- `docker-compose.yml`: persistent PostgreSQL and Redis services with health checks and Redis AOF.

## Local setup

1. Install Node.js 22+ and Docker Desktop.
2. Copy `.env.example` to `.env` and replace every placeholder locally.
3. Run the commands below.

```bash
npm install
npm run infra:up
npm run db:generate
npm run db:migrate
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run build
```

`GET /api/health/live` reports process liveness. `GET /api/health/ready` reports readiness only when both PostgreSQL and Redis respond.

## Google OAuth configuration

Create an OAuth 2.0 Web Application in Google Cloud. Register the exact frontend URL from `FRONTEND_URL` as an authorized JavaScript origin and the exact `GOOGLE_CALLBACK_URL` as an authorized redirect URI. Add the client ID and secret only to your untracked local `.env`.

The backend requests only `openid`, `email`, and `profile`. It stores the stable Google subject and display profile, keeps sessions in Redis, and never sends OAuth tokens to the frontend. Authentication routes are:

- `GET /api/auth/google`
- `GET /api/auth/google/callback`
- `GET /api/auth/me`
- `POST /api/auth/logout`

Never commit `.env` or credentials. All exposed ports, credentials, limits, and delays are provided through environment configuration; the Compose file intentionally has no credential or host-port defaults.

Complete infrastructure, OAuth, Ethereal, architecture, testing, and demonstration instructions will be added as each verified implementation phase lands.
