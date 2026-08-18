import type { SendAttemptOutcome } from "@prisma/client";
import { DelayedError, UnrecoverableError } from "bullmq";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config/env.js";
import type { DatabaseClient } from "../db/prisma.js";
import type { DeliveryReceipt, Mailer } from "../email/mailer.js";
import type { SenderRateLimiter } from "../rate-limit/sender-rate-limiter.js";
import type { EmailJobProcessor } from "../queue/email-worker.js";

type ProcessorConfig = Pick<AppConfig, "SMTP_BACKOFF_MS">;
type DeliveryClassification = "permanent" | "transient" | "unknown";
const terminalStatuses = new Set(["SENT", "FAILED", "DELIVERY_UNKNOWN", "CANCELLED"]);

class RejectedDeliveryError extends Error {
  constructor() {
    super("SMTP rejected every recipient");
    this.name = "RejectedDeliveryError";
  }
}

function property(error: object, key: string): unknown {
  return Reflect.get(error, key);
}

function smtpCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = property(error, "code");
  return typeof code === "string" ? code : null;
}

function smtpResponseCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const code = property(error, "responseCode");
  return typeof code === "number" && Number.isInteger(code) ? code : null;
}

export function classifyDeliveryError(error: unknown): DeliveryClassification {
  if (error instanceof RejectedDeliveryError) return "permanent";

  const code = smtpCode(error);
  const responseCode = smtpResponseCode(error);
  if (code === "EAUTH" || code === "EENVELOPE" || (responseCode !== null && responseCode >= 500)) {
    return "permanent";
  }
  if (
    code === "EDNS" ||
    code === "ECONNECTION" ||
    (responseCode !== null && responseCode >= 400 && responseCode < 500)
  ) {
    return "transient";
  }
  return "unknown";
}

function safeError(classification: DeliveryClassification, error: unknown) {
  const code = smtpCode(error) ?? "SMTP_DELIVERY_ERROR";
  const messages: Record<DeliveryClassification, string> = {
    permanent: "SMTP permanently rejected the message",
    transient: "SMTP was temporarily unavailable before accepting the message",
    unknown: "SMTP delivery outcome is unknown",
  };
  return { code: code.slice(0, 100), message: messages[classification] };
}

async function updateBatchCompletion(database: DatabaseClient, batchId: string): Promise<void> {
  const remaining = await database.scheduledEmail.count({
    where: {
      batchId,
      status: { in: ["SCHEDULED", "RATE_LIMITED", "PROCESSING", "RETRYABLE"] },
    },
  });
  if (remaining !== 0) return;

  const unsuccessful = await database.scheduledEmail.count({
    where: { batchId, status: { in: ["FAILED", "DELIVERY_UNKNOWN", "CANCELLED"] } },
  });
  await database.emailBatch.update({
    where: { id: batchId },
    data: { status: unsuccessful === 0 ? "COMPLETED" : "PARTIALLY_FAILED" },
  });
}

async function recordRateLimit(
  database: DatabaseClient,
  scheduledEmailId: string,
  nextAvailableAt: Date,
  now: Date,
): Promise<void> {
  await database.$transaction(async (transaction) => {
    const updated = await transaction.scheduledEmail.updateManyAndReturn({
      where: {
        id: scheduledEmailId,
        status: { in: ["SCHEDULED", "RATE_LIMITED", "RETRYABLE"] },
      },
      data: {
        status: "RATE_LIMITED",
        nextAttemptAt: nextAvailableAt,
        rateLimitedUntil: nextAvailableAt,
        attemptCount: { increment: 1 },
      },
      select: { id: true, attemptCount: true },
    });
    const email = updated[0];
    if (email === undefined) return;

    await transaction.sendAttempt.create({
      data: {
        scheduledEmailId: email.id,
        attemptNumber: email.attemptCount,
        attemptToken: randomUUID(),
        startedAt: now,
        finishedAt: now,
        outcome: "RATE_LIMITED",
      },
    });
  });
}

async function claimEmail(database: DatabaseClient, scheduledEmailId: string, now: Date) {
  return database.$transaction(async (transaction) => {
    const processingToken = randomUUID();
    const updated = await transaction.scheduledEmail.updateManyAndReturn({
      where: {
        id: scheduledEmailId,
        processingToken: null,
        status: { in: ["SCHEDULED", "RATE_LIMITED", "RETRYABLE"] },
      },
      data: {
        status: "PROCESSING",
        processingToken,
        processingStartedAt: now,
        rateLimitedUntil: null,
        attemptCount: { increment: 1 },
      },
      select: { id: true, batchId: true, attemptCount: true },
    });
    const email = updated[0];
    if (email === undefined) return null;

    await transaction.sendAttempt.create({
      data: {
        scheduledEmailId: email.id,
        attemptNumber: email.attemptCount,
        attemptToken: processingToken,
        startedAt: now,
        outcome: "CLAIMED",
      },
    });

    return { ...email, processingToken };
  });
}

async function recordAccepted(
  database: DatabaseClient,
  claim: { id: string; batchId: string; processingToken: string },
  receipt: DeliveryReceipt,
  now: Date,
): Promise<void> {
  await database.$transaction(async (transaction) => {
    const updated = await transaction.scheduledEmail.updateMany({
      where: { id: claim.id, status: "PROCESSING", processingToken: claim.processingToken },
      data: {
        status: "SENT",
        sentAt: now,
        nextAttemptAt: now,
        processingToken: null,
        processingStartedAt: null,
        smtpMessageId: receipt.messageId,
        etherealPreviewUrl: receipt.previewUrl,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    if (updated.count !== 1) {
      throw new Error("The claimed email could not be finalized");
    }

    await transaction.sendAttempt.update({
      where: { attemptToken: claim.processingToken },
      data: {
        finishedAt: now,
        outcome: "SMTP_ACCEPTED",
        responseMetadata: {
          acceptedCount: receipt.acceptedCount,
          rejectedCount: receipt.rejectedCount,
        },
      },
    });
  });
  await updateBatchCompletion(database, claim.batchId);
}

async function recordFailure(
  database: DatabaseClient,
  claim: { id: string; batchId: string; processingToken: string },
  classification: DeliveryClassification,
  finalRetry: boolean,
  config: ProcessorConfig,
  error: unknown,
  now: Date,
): Promise<"failed" | "retryable" | "unknown"> {
  const sanitized = safeError(classification, error);
  const result =
    classification === "transient" && !finalRetry
      ? "retryable"
      : classification === "unknown"
        ? "unknown"
        : "failed";
  const status =
    result === "retryable" ? "RETRYABLE" : result === "unknown" ? "DELIVERY_UNKNOWN" : "FAILED";
  const outcome: SendAttemptOutcome =
    result === "retryable"
      ? "TRANSIENT_FAILURE"
      : result === "unknown"
        ? "DELIVERY_UNKNOWN"
        : "DEFINITE_FAILURE";

  await database.$transaction(async (transaction) => {
    await transaction.scheduledEmail.updateMany({
      where: { id: claim.id, status: "PROCESSING", processingToken: claim.processingToken },
      data: {
        status,
        nextAttemptAt:
          result === "retryable" ? new Date(now.getTime() + config.SMTP_BACKOFF_MS) : now,
        processingToken: null,
        processingStartedAt: null,
        lastErrorCode: sanitized.code,
        lastErrorMessage: sanitized.message,
      },
    });
    await transaction.sendAttempt.update({
      where: { attemptToken: claim.processingToken },
      data: {
        finishedAt: now,
        outcome,
        errorCode: sanitized.code,
        errorMessage: sanitized.message,
      },
    });
  });

  if (result !== "retryable") {
    await updateBatchCompletion(database, claim.batchId);
  }
  return result;
}

export function createEmailProcessor(
  database: DatabaseClient,
  rateLimiter: SenderRateLimiter,
  mailer: Mailer,
  config: ProcessorConfig,
): EmailJobProcessor {
  return async (job, token) => {
    const email = await database.scheduledEmail.findUnique({
      where: { id: job.data.scheduledEmailId },
      include: { batch: true, sender: true },
    });
    if (email === null || terminalStatuses.has(email.status) || email.status === "PROCESSING") {
      return;
    }

    const now = new Date();
    if (email.nextAttemptAt > now) {
      await job.moveToDelayed(email.nextAttemptAt.getTime(), token);
      throw new DelayedError();
    }

    const admission = await rateLimiter.reserve(
      {
        senderId: email.senderId,
        hourlyLimit: email.sender.hourlyLimit,
        minimumDelayMs: email.sender.minimumDelayMs,
      },
      email.id,
      now,
    );
    if (!admission.admitted) {
      await recordRateLimit(database, email.id, admission.nextAvailableAt, now);
      await job.moveToDelayed(admission.nextAvailableAt.getTime(), token);
      throw new DelayedError();
    }

    const claim = await claimEmail(database, email.id, now);
    if (claim === null) return;

    try {
      const receipt = await mailer.send({
        scheduledEmailId: email.id,
        fromName: email.sender.displayName,
        fromEmail: email.sender.email,
        recipientEmail: email.recipientEmail,
        subject: email.batch.subject,
        bodyText: email.batch.bodyText,
      });
      if (receipt.acceptedCount === 0) throw new RejectedDeliveryError();

      await recordAccepted(database, claim, receipt, new Date());
    } catch (error) {
      const classification = classifyDeliveryError(error);
      const attempts = job.opts.attempts ?? 1;
      const finalRetry = job.attemptsMade + 1 >= attempts;
      const result = await recordFailure(
        database,
        claim,
        classification,
        finalRetry,
        config,
        error,
        new Date(),
      );
      if (result !== "retryable") {
        throw new UnrecoverableError(`Email delivery ${result}`);
      }
      // Do not attach the SMTP error as a cause because BullMQ persists error stacks in Redis.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Transient SMTP delivery failure");
    }
  };
}
