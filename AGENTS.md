# AGENTS.md

## Architecture

- npm-workspace monorepo: `apps/backend` and `apps/frontend`.
- Backend: Express + strict TypeScript, Prisma/PostgreSQL, BullMQ/Redis, Nodemailer/Ethereal, real Google OAuth, and separate API/worker entry points.
- Frontend: React + Vite + strict TypeScript + Tailwind.
- PostgreSQL owns durable email status. Redis owns BullMQ execution, sessions, and atomic per-sender rate-limit state.
- Validate configuration at startup and API data at every boundary.

## Commands

- Install: `npm install`
- Infrastructure: `npm run infra:up` / `npm run infra:down`
- Prisma: `npm run db:generate`, `npm run db:migrate`, `npm run db:seed`
- Development: `npm run dev`, or `npm run dev:backend`, `npm run dev:worker`, `npm run dev:frontend`
- Quality: `npm run typecheck`, `npm run lint`, `npm test`
- Integration/E2E: `npm run test:integration`, `npm run test:e2e`
- Production build: `npm run build`

## TypeScript standards

- Enable strict mode; do not use `any`, unchecked casts, or non-null assertions without a documented reason.
- Use ESM, explicit domain types, narrow functions, and exhaustive enum/union handling.
- Validate untrusted env, HTTP, file, queue, and SMTP data with schemas; infer types from schemas where practical.
- Keep route handlers thin. Put business rules in services and infrastructure behind injectable adapters.
- Never log secrets, session cookies, OAuth/SMTP tokens, full email bodies, or unsanitized errors.
- Use UTC in backend/storage and convert only at the UI boundary.

## Non-negotiable rules

- Never use cron or cron libraries.
- Never hardcode rate limits, delays, ports, credentials, or secrets.
- Never commit `.env` files or credentials.
- Use BullMQ delayed jobs for scheduling.
- Use deterministic BullMQ job IDs.
- Treat PostgreSQL as the source of truth for email status.
- Use Redis-backed atomic rate limiting safe across multiple workers.
- Validate API inputs.
- Run relevant type-checks, linting, and tests after every phase.
- Do not proceed to the next implementation phase until the current phase works.
