import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../../src/db/prisma.js";
import { createEmailQueue } from "../../src/queue/email-queue.js";
import { createEmailWorker } from "../../src/queue/email-worker.js";
import { reconcileEmailQueue } from "../../src/queue/reconcile.js";

const databaseUrl = process.env["DATABASE_URL"];
const redisUrl = process.env["REDIS_URL"];
if (databaseUrl === undefined || redisUrl === undefined) {
  throw new Error("DATABASE_URL and REDIS_URL are required for integration tests");
}

const database = createPrismaClient(databaseUrl);
const testRun = randomUUID();
const testEmail = `queue-${testRun}@example.com`;
const queueConfig = {
  BULLMQ_PREFIX: `reachinbox-test-${testRun}`,
  EMAIL_QUEUE_NAME: "email-sends-test",
  JOB_RETENTION_COUNT: 100,
  PROCESSING_LEASE_MS: 1_000,
  RECONCILIATION_BATCH_SIZE: 100,
  REDIS_URL: redisUrl,
  SMTP_BACKOFF_MS: 100,
  SMTP_MAX_ATTEMPTS: 2,
  WORKER_CONCURRENCY: 2,
};

let scheduledEmailId: string;
let scheduledAt: Date;
let ownerId: string;

beforeAll(async () => {
  await database.$connect();
  const user = await database.user.create({
    data: {
      googleSubject: `queue-subject-${testRun}`,
      email: testEmail,
      name: "Queue Integration",
      lastLoginAt: new Date(),
    },
  });
  ownerId = user.id;
  const sender = await database.emailSender.create({
    data: {
      userId: user.id,
      displayName: "Queue Sender",
      email: testEmail,
      normalizedEmail: testEmail,
      isDefault: true,
      hourlyLimit: 100,
      minimumDelayMs: 100,
    },
  });
  const batch = await database.emailBatch.create({
    data: {
      userId: user.id,
      senderId: sender.id,
      idempotencyKey: `queue-batch-${testRun}`,
      subject: "Delayed queue test",
      bodyText: "Test body",
      startAt: new Date(Date.now() + 750),
      requestedHourlyLimit: 100,
      requestedMinimumDelayMs: 100,
      sourceFilename: "queue-test.txt",
      totalRows: 2,
      validRecipientCount: 2,
      invalidRecipientCount: 0,
      duplicateRecipientCount: 0,
      status: "SCHEDULED",
    },
  });

  scheduledEmailId = randomUUID();
  scheduledAt = new Date(Date.now() + 750);
  await database.scheduledEmail.createMany({
    data: [
      {
        id: scheduledEmailId,
        batchId: batch.id,
        senderId: sender.id,
        recipientEmail: `lead-${testRun}@example.com`,
        normalizedRecipientEmail: `lead-${testRun}@example.com`,
        sequenceNumber: 0,
        scheduledAt,
        nextAttemptAt: scheduledAt,
        bullJobId: `email_${scheduledEmailId}`,
        idempotencyKey: `queue-email-${testRun}`,
      },
      {
        id: randomUUID(),
        batchId: batch.id,
        senderId: sender.id,
        recipientEmail: `stale-${testRun}@example.com`,
        normalizedRecipientEmail: `stale-${testRun}@example.com`,
        sequenceNumber: 1,
        scheduledAt,
        nextAttemptAt: scheduledAt,
        status: "PROCESSING",
        processingToken: randomUUID(),
        processingStartedAt: new Date(Date.now() - 10_000),
        bullJobId: `email_stale_${testRun}`,
        idempotencyKey: `queue-stale-${testRun}`,
      },
    ],
  });
});

afterAll(async () => {
  const cleanupQueue = createEmailQueue(queueConfig);
  await cleanupQueue.obliterate({ force: true });
  await cleanupQueue.close();
  await database.scheduledEmail.deleteMany({ where: { batch: { userId: ownerId } } });
  await database.emailBatch.deleteMany({ where: { userId: ownerId } });
  await database.emailSender.deleteMany({ where: { userId: ownerId } });
  await database.user.delete({ where: { id: ownerId } });
  await database.$disconnect();
});

describe("BullMQ delayed queue and reconciliation", () => {
  it("deduplicates reconciliation, survives producer restart, and runs only when due", async () => {
    const firstQueue = createEmailQueue(queueConfig);
    const firstReconciliation = await reconcileEmailQueue(firstQueue, database, queueConfig);
    const targetAfterFirst = await firstQueue.getJob(`email_${scheduledEmailId}`);
    const secondReconciliation = await reconcileEmailQueue(firstQueue, database, queueConfig);
    const targetAfterSecond = await firstQueue.getJob(`email_${scheduledEmailId}`);

    expect(firstReconciliation.deliveryUnknown).toBe(1);
    expect(secondReconciliation.deliveryUnknown).toBe(0);
    expect(targetAfterFirst?.id).toBe(`email_${scheduledEmailId}`);
    expect(targetAfterSecond?.id).toBe(targetAfterFirst?.id);
    expect(targetAfterSecond?.timestamp).toBe(targetAfterFirst?.timestamp);
    await firstQueue.close();

    const restartedQueue = createEmailQueue(queueConfig);
    let worker: ReturnType<typeof createEmailWorker> | undefined;
    const processed = new Promise<{ id: string; processedAt: Date }>((resolve) => {
      const createdWorker = createEmailWorker(queueConfig, async (job) => {
        if (job.data.scheduledEmailId === scheduledEmailId) {
          resolve({ id: job.data.scheduledEmailId, processedAt: new Date() });
        }
      });
      createdWorker.on("error", () => undefined);
      worker = createdWorker;
    });

    const result = await processed;
    if (worker !== undefined) {
      await worker.close();
    }
    expect(result.id).toBe(scheduledEmailId);
    expect(result.processedAt.getTime()).toBeGreaterThanOrEqual(scheduledAt.getTime() - 50);

    const completedJob = await restartedQueue.getJob(`email_${scheduledEmailId}`);
    expect(await completedJob?.getState()).toBe("completed");
    await restartedQueue.close();

    const stale = await database.scheduledEmail.findFirst({
      where: { batch: { userId: ownerId }, status: "DELIVERY_UNKNOWN" },
    });
    expect(stale?.lastErrorCode).toBe("STALE_PROCESSING_LEASE");
  }, 15_000);
});
