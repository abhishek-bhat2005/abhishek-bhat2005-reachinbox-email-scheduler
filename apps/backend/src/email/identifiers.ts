import { createHash, randomUUID } from "node:crypto";

export function createScheduledEmailId(): string {
  return randomUUID();
}

export function createBullJobId(scheduledEmailId: string): string {
  return `email_${scheduledEmailId}`;
}

export function createRecipientIdempotencyKey(
  batchId: string,
  normalizedRecipientEmail: string,
): string {
  const digest = createHash("sha256")
    .update(batchId)
    .update("\0")
    .update(normalizedRecipientEmail)
    .digest("hex");

  return `recipient_${digest}`;
}
