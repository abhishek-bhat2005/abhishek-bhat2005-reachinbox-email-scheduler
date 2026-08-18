import { describe, expect, it } from "vitest";

import { environmentSchema } from "../../src/config/env.js";

const validEnvironment = {
  NODE_ENV: "test",
  BACKEND_HOST: "127.0.0.1",
  BACKEND_PORT: "4100",
  FRONTEND_URL: "http://127.0.0.1:5100",
  TRUST_PROXY: "false",
  DATABASE_URL: "postgresql://test:test@127.0.0.1:6100/test",
  REDIS_URL: "redis://:test@127.0.0.1:7100",
  REDIS_TLS: "false",
  BULLMQ_PREFIX: "test-queue",
  EMAIL_QUEUE_NAME: "test-emails",
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_CALLBACK_URL: "http://127.0.0.1:4100/api/auth/google/callback",
  SESSION_SECRET: "test-session-secret-that-is-long-enough",
  SESSION_COOKIE_NAME: "test-session",
  SESSION_REDIS_PREFIX: "test-session:",
  SESSION_TTL_MS: "3600000",
  SMTP_HOST: "smtp.test.invalid",
  SMTP_PORT: "8100",
  SMTP_SECURE: "false",
  SMTP_USER: "test-user",
  SMTP_PASSWORD: "test-password",
  SMTP_DEFAULT_FROM_NAME: "Test Sender",
  SMTP_DEFAULT_FROM_EMAIL: "sender@test.invalid",
  SMTP_CONNECTION_TIMEOUT_MS: "5000",
  SMTP_SOCKET_TIMEOUT_MS: "5000",
  WORKER_CONCURRENCY: "4",
  DEFAULT_MIN_SEND_DELAY_MS: "2000",
  MIN_SEND_DELAY_MS: "1000",
  MAX_SEND_DELAY_MS: "60000",
  DEFAULT_EMAILS_PER_HOUR: "200",
  MAX_EMAILS_PER_HOUR: "1000",
  SMTP_MAX_ATTEMPTS: "3",
  SMTP_BACKOFF_MS: "1000",
  PROCESSING_LEASE_MS: "30000",
  JOB_RETENTION_COUNT: "1000",
  RECONCILIATION_BATCH_SIZE: "250",
  RATE_LIMIT_RESERVATION_TTL_MS: "7200000",
  MAX_UPLOAD_BYTES: "1048576",
  MAX_LEADS_PER_BATCH: "5000",
  MAX_SUBJECT_LENGTH: "998",
  MAX_BODY_LENGTH: "100000",
  MAX_SCHEDULE_HORIZON_DAYS: "365",
  API_PAGE_SIZE: "25",
  API_MAX_PAGE_SIZE: "100",
  LOG_LEVEL: "silent",
} as const;

describe("environment configuration", () => {
  it("coerces and validates a complete environment", () => {
    const result = environmentSchema.parse(validEnvironment);

    expect(result.BACKEND_PORT).toBe(4100);
    expect(result.REDIS_TLS).toBe(false);
    expect(result.WORKER_CONCURRENCY).toBe(4);
  });

  it("rejects missing secrets", () => {
    const missingSecret: Record<string, string> = { ...validEnvironment };
    Reflect.deleteProperty(missingSecret, "SESSION_SECRET");

    expect(() => environmentSchema.parse(missingSecret)).toThrow();
  });

  it("rejects inconsistent operational bounds", () => {
    expect(() =>
      environmentSchema.parse({
        ...validEnvironment,
        DEFAULT_EMAILS_PER_HOUR: "2000",
        MAX_EMAILS_PER_HOUR: "1000",
      }),
    ).toThrow();
  });
});
