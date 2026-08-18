export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export interface Sender {
  id: string;
  displayName: string;
  email: string;
  isDefault: boolean;
  isActive: boolean;
  hourlyLimit: number;
  minimumDelayMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface ComposeConfig {
  defaults: {
    hourlyLimit: number;
    minimumDelayMs: number;
    pageSize: number;
  };
  limits: {
    hourlyLimit: { min: number; max: number };
    minimumDelayMs: { min: number; max: number };
    maxBodyLength: number;
    maxLeadsPerBatch: number;
    maxScheduleHorizonDays: number;
    maxSubjectLength: number;
    maxUploadBytes: number;
  };
}

export interface ScheduledEmail {
  id: string;
  recipientEmail: string;
  subject: string;
  scheduledAt: string;
  nextAttemptAt: string;
  status: "scheduled" | "rate_limited" | "processing" | "retryable";
  sender: { displayName: string; email: string };
}

export interface SentEmail {
  id: string;
  recipientEmail: string;
  subject: string;
  sentAt: string | null;
  completedAt: string;
  status: "sent" | "failed" | "delivery_unknown";
  etherealPreviewUrl: string | null;
  error: string | null;
  sender: { displayName: string; email: string };
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ScheduleBatchResponse {
  replayed: boolean;
  batch: {
    id: string;
    status: string;
    startAt: string;
    totalRows: number;
    validRecipientCount: number;
    invalidRecipientCount: number;
    duplicateRecipientCount: number;
    invalidRows: { row: number; value: string; reason: string }[];
  };
}
