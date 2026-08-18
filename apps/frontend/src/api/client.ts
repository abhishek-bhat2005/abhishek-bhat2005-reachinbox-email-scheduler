import type {
  ComposeConfig,
  CursorPage,
  ScheduleBatchResponse,
  ScheduledEmail,
  Sender,
  SentEmail,
  User,
} from "./types";
import { z } from "zod";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL;

if (typeof apiBaseUrl !== "string" || apiBaseUrl.length === 0) {
  throw new Error("VITE_API_BASE_URL is required");
}

export const dashboardRefreshMs = Number(import.meta.env.VITE_DASHBOARD_REFRESH_MS);

if (!Number.isFinite(dashboardRefreshMs) || dashboardRefreshMs <= 0) {
  throw new Error("VITE_DASHBOARD_REFRESH_MS must be a positive number");
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const errorEnvelopeSchema = z.object({
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
});
const userSchema: z.ZodType<User> = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
});
const senderSchema: z.ZodType<Sender> = z.object({
  id: z.string(),
  displayName: z.string(),
  email: z.string(),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  hourlyLimit: z.number(),
  minimumDelayMs: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const composeConfigSchema: z.ZodType<ComposeConfig> = z.object({
  defaults: z.object({ hourlyLimit: z.number(), minimumDelayMs: z.number(), pageSize: z.number() }),
  limits: z.object({
    hourlyLimit: z.object({ min: z.number(), max: z.number() }),
    minimumDelayMs: z.object({ min: z.number(), max: z.number() }),
    maxBodyLength: z.number(),
    maxLeadsPerBatch: z.number(),
    maxScheduleHorizonDays: z.number(),
    maxSubjectLength: z.number(),
    maxUploadBytes: z.number(),
  }),
});
const scheduledEmailSchema: z.ZodType<ScheduledEmail> = z.object({
  id: z.string(),
  recipientEmail: z.string(),
  subject: z.string(),
  scheduledAt: z.string(),
  nextAttemptAt: z.string(),
  status: z.enum(["scheduled", "rate_limited", "processing", "retryable"]),
  sender: z.object({ displayName: z.string(), email: z.string() }),
});
const sentEmailSchema: z.ZodType<SentEmail> = z.object({
  id: z.string(),
  recipientEmail: z.string(),
  subject: z.string(),
  sentAt: z.string().nullable(),
  completedAt: z.string(),
  status: z.enum(["sent", "failed", "delivery_unknown"]),
  etherealPreviewUrl: z.string().nullable(),
  error: z.string().nullable(),
  sender: z.object({ displayName: z.string(), email: z.string() }),
});
const scheduleBatchSchema: z.ZodType<ScheduleBatchResponse> = z.object({
  replayed: z.boolean(),
  batch: z.object({
    id: z.string(),
    status: z.string(),
    startAt: z.string(),
    totalRows: z.number(),
    validRecipientCount: z.number(),
    invalidRecipientCount: z.number(),
    duplicateRecipientCount: z.number(),
    invalidRows: z.array(z.object({ row: z.number(), value: z.string(), reason: z.string() })),
  }),
});

function cursorPageSchema<T>(itemSchema: z.ZodType<T>): z.ZodType<CursorPage<T>> {
  return z.object({ items: z.array(itemSchema), nextCursor: z.string().nullable() });
}

async function apiRequest<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let code = "REQUEST_FAILED";
    let message = "The request could not be completed";
    try {
      const parsed = errorEnvelopeSchema.safeParse(await response.json());
      if (parsed.success) {
        code = parsed.data.error?.code ?? code;
        message = parsed.data.error?.message ?? message;
      }
    } catch {
      // The fallback below intentionally avoids exposing an untrusted response body.
    }
    throw new ApiError(response.status, code, message);
  }

  if (response.status === 204) return schema.parse(undefined);
  return schema.parse(await response.json());
}

export function googleLoginUrl(): string {
  return `${apiBaseUrl}/auth/google`;
}

export const api = {
  currentUser: async () => apiRequest("/auth/me", z.object({ user: userSchema })),
  logout: async () => apiRequest("/auth/logout", z.undefined(), { method: "POST" }),
  composeConfig: async () => apiRequest("/config/compose", composeConfigSchema),
  senders: async () => apiRequest("/senders", z.object({ senders: z.array(senderSchema) })),
  scheduled: async (cursor?: string) =>
    apiRequest(
      `/emails/scheduled${cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`}`,
      cursorPageSchema(scheduledEmailSchema),
    ),
  sent: async (cursor?: string) =>
    apiRequest(
      `/emails/sent${cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`}`,
      cursorPageSchema(sentEmailSchema),
    ),
  scheduleBatch: async (formData: FormData, idempotencyKey: string) =>
    apiRequest("/email-batches", scheduleBatchSchema, {
      method: "POST",
      body: formData,
      headers: { "Idempotency-Key": idempotencyKey },
    }),
};
