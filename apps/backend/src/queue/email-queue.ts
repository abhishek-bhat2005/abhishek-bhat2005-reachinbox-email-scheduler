import { Queue, type JobsOptions } from "bullmq";

import type { AppConfig } from "../config/env.js";
import type { DatabaseClient } from "../db/prisma.js";

export const emailJobName = "send-email" as const;

export interface EmailJobData {
  scheduledEmailId: string;
}

export type EmailQueue = Queue<EmailJobData, void, typeof emailJobName>;

type QueueConfig = Pick<
  AppConfig,
  | "BULLMQ_PREFIX"
  | "EMAIL_QUEUE_NAME"
  | "JOB_RETENTION_COUNT"
  | "RECONCILIATION_BATCH_SIZE"
  | "REDIS_URL"
  | "SMTP_BACKOFF_MS"
  | "SMTP_MAX_ATTEMPTS"
>;

export function bullMqConnection(config: Pick<AppConfig, "REDIS_URL">, name: string) {
  return {
    url: config.REDIS_URL,
    connectionName: name,
    maxRetriesPerRequest: null,
  };
}

export function createEmailQueue(config: QueueConfig): EmailQueue {
  return new Queue<EmailJobData, void, typeof emailJobName>(config.EMAIL_QUEUE_NAME, {
    connection: bullMqConnection(config, "email-queue"),
    prefix: config.BULLMQ_PREFIX,
    defaultJobOptions: {
      attempts: config.SMTP_MAX_ATTEMPTS,
      backoff: { type: "fixed", delay: config.SMTP_BACKOFF_MS },
      removeOnComplete: { count: config.JOB_RETENTION_COUNT },
      removeOnFail: { count: config.JOB_RETENTION_COUNT },
    },
  });
}

interface QueueableEmail {
  id: string;
  bullJobId: string;
  nextAttemptAt: Date;
}

function jobOptions(email: QueueableEmail, now: Date): JobsOptions {
  return {
    jobId: email.bullJobId,
    delay: Math.max(0, email.nextAttemptAt.getTime() - now.getTime()),
  };
}

export async function enqueueEmailRows(
  queue: EmailQueue,
  emails: QueueableEmail[],
  now = new Date(),
): Promise<void> {
  if (emails.length === 0) {
    return;
  }

  await queue.addBulk(
    emails.map((email) => ({
      name: emailJobName,
      data: { scheduledEmailId: email.id },
      opts: jobOptions(email, now),
    })),
  );
}

export async function enqueueEmailBatch(
  queue: EmailQueue,
  database: DatabaseClient,
  batchId: string,
  config: Pick<AppConfig, "RECONCILIATION_BATCH_SIZE">,
): Promise<void> {
  let cursor: string | undefined;

  while (true) {
    const emails = await database.scheduledEmail.findMany({
      where: {
        batchId,
        status: { in: ["SCHEDULED", "RATE_LIMITED", "RETRYABLE"] },
      },
      select: { id: true, bullJobId: true, nextAttemptAt: true },
      orderBy: { id: "asc" },
      take: config.RECONCILIATION_BATCH_SIZE,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });

    await enqueueEmailRows(queue, emails);

    const last = emails.at(-1);
    if (last === undefined || emails.length < config.RECONCILIATION_BATCH_SIZE) {
      return;
    }
    cursor = last.id;
  }
}
