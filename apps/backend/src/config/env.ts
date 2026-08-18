import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const workspaceEnvironmentPath = fileURLToPath(new URL("../../../../.env", import.meta.url));

loadDotenv({ path: workspaceEnvironmentPath, quiet: true });

const positiveInteger = z.coerce.number().int().positive();
const nonNegativeInteger = z.coerce.number().int().nonnegative();
const booleanString = z.enum(["true", "false"]).transform((value) => value === "true");

export const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    BACKEND_HOST: z.string().min(1),
    BACKEND_PORT: positiveInteger,
    FRONTEND_URL: z.url(),
    TRUST_PROXY: booleanString,
    DATABASE_URL: z.string().startsWith("postgresql://"),
    REDIS_URL: z.string().startsWith("redis://"),
    REDIS_TLS: booleanString,
    BULLMQ_PREFIX: z.string().min(1),
    EMAIL_QUEUE_NAME: z.string().min(1),
    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),
    GOOGLE_CALLBACK_URL: z.url(),
    SESSION_SECRET: z.string().min(32),
    SESSION_COOKIE_NAME: z.string().min(1),
    SESSION_REDIS_PREFIX: z.string().min(1),
    SESSION_TTL_MS: positiveInteger,
    SMTP_HOST: z.string().min(1),
    SMTP_PORT: positiveInteger,
    SMTP_SECURE: booleanString,
    SMTP_USER: z.string().min(1),
    SMTP_PASSWORD: z.string().min(1),
    SMTP_DEFAULT_FROM_NAME: z.string().min(1),
    SMTP_DEFAULT_FROM_EMAIL: z.email(),
    SMTP_CONNECTION_TIMEOUT_MS: positiveInteger,
    SMTP_SOCKET_TIMEOUT_MS: positiveInteger,
    WORKER_CONCURRENCY: positiveInteger,
    DEFAULT_MIN_SEND_DELAY_MS: nonNegativeInteger,
    MIN_SEND_DELAY_MS: nonNegativeInteger,
    MAX_SEND_DELAY_MS: positiveInteger,
    DEFAULT_EMAILS_PER_HOUR: positiveInteger,
    MAX_EMAILS_PER_HOUR: positiveInteger,
    SMTP_MAX_ATTEMPTS: positiveInteger,
    SMTP_BACKOFF_MS: positiveInteger,
    PROCESSING_LEASE_MS: positiveInteger,
    JOB_RETENTION_COUNT: positiveInteger,
    RECONCILIATION_BATCH_SIZE: positiveInteger,
    RATE_LIMIT_RESERVATION_TTL_MS: positiveInteger,
    MAX_UPLOAD_BYTES: positiveInteger,
    MAX_LEADS_PER_BATCH: positiveInteger,
    MAX_SUBJECT_LENGTH: positiveInteger,
    MAX_BODY_LENGTH: positiveInteger,
    MAX_SCHEDULE_HORIZON_DAYS: positiveInteger,
    API_PAGE_SIZE: positiveInteger,
    API_MAX_PAGE_SIZE: positiveInteger,
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]),
  })
  .superRefine((config, context) => {
    if (config.MIN_SEND_DELAY_MS > config.DEFAULT_MIN_SEND_DELAY_MS) {
      context.addIssue({
        code: "custom",
        path: ["DEFAULT_MIN_SEND_DELAY_MS"],
        message: "must be greater than or equal to MIN_SEND_DELAY_MS",
      });
    }

    if (config.DEFAULT_MIN_SEND_DELAY_MS > config.MAX_SEND_DELAY_MS) {
      context.addIssue({
        code: "custom",
        path: ["DEFAULT_MIN_SEND_DELAY_MS"],
        message: "must be less than or equal to MAX_SEND_DELAY_MS",
      });
    }

    if (config.DEFAULT_EMAILS_PER_HOUR > config.MAX_EMAILS_PER_HOUR) {
      context.addIssue({
        code: "custom",
        path: ["DEFAULT_EMAILS_PER_HOUR"],
        message: "must be less than or equal to MAX_EMAILS_PER_HOUR",
      });
    }

    if (config.API_PAGE_SIZE > config.API_MAX_PAGE_SIZE) {
      context.addIssue({
        code: "custom",
        path: ["API_PAGE_SIZE"],
        message: "must be less than or equal to API_MAX_PAGE_SIZE",
      });
    }
  });

export type AppConfig = z.infer<typeof environmentSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  return environmentSchema.parse(environment);
}
