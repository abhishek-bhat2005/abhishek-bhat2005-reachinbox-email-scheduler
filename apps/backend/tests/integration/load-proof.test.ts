import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../../src/db/prisma.js";
import type { Mailer } from "../../src/email/mailer.js";
import { createEmailQueue, enqueueEmailBatch } from "../../src/queue/email-queue.js";
import { createEmailWorker } from "../../src/queue/email-worker.js";
import { SenderRateLimiter } from "../../src/rate-limit/sender-rate-limiter.js";
import { createRedisClient } from "../../src/redis/client.js";
import { createEmailProcessor } from "../../src/worker/email-processor.js";

const databaseUrl = process.env["DATABASE_URL"];
const redisUrl = process.env["REDIS_URL"];
if (databaseUrl === undefined || redisUrl === undefined) {
  throw new Error("DATABASE_URL and REDIS_URL are required for integration tests");
}

const emailCount = 1_000;
const testRun = randomUUID();
const ownerEmail = `load-${testRun}@example.com`;
const database = createPrismaClient(databaseUrl);
const redis = createRedisClient(redisUrl, "integration-load-proof");
const config = {
  BULLMQ_PREFIX: `load-proof-${testRun}`,
  EMAIL_QUEUE_NAME: "email-load-proof",
  JOB_RETENTION_COUNT: emailCount,
  RATE_LIMIT_RESERVATION_TTL_MS: 7_200_000,
  RECONCILIATION_BATCH_SIZE: 100,
  REDIS_URL: redisUrl,
  SMTP_BACKOFF_MS: 100,
  SMTP_MAX_ATTEMPTS: 2,
  WORKER_CONCURRENCY: 10,
};
const queue = createEmailQueue(config);
const acceptanceCounts = new Map<string, number>();
const workerErrors: Error[] = [];
let activeSends = 0;
let maximumActiveSends = 0;

const mailer: Mailer = {
  async send(message) {
    activeSends += 1;
    maximumActiveSends = Math.max(maximumActiveSends, activeSends);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      acceptanceCounts.set(
        message.scheduledEmailId,
        (acceptanceCounts.get(message.scheduledEmailId) ?? 0) + 1,
      );
      return {
        messageId: `<${message.scheduledEmailId}@load.invalid>`,
        previewUrl: `https://example.invalid/message/${message.scheduledEmailId}`,
        acceptedCount: 1,
        rejectedCount: 0,
      };
    } finally {
      activeSends -= 1;
    }
  },
  close() {
    return undefined;
  },
};

let ownerId: string;
let batchId: string;
const workers: ReturnType<typeof createEmailWorker>[] = [];

async function waitForTerminalRows(): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const sent = await database.scheduledEmail.count({ where: { batchId, status: "SENT" } });
    if (sent === emailCount) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }

  const statuses = await database.scheduledEmail.groupBy({
    by: ["status"],
    where: { batchId },
    _count: { _all: true },
  });
  throw new Error(`Timed out waiting for load batch: ${JSON.stringify(statuses)}`);
}

beforeAll(async () => {
  await Promise.all([database.$connect(), redis.connect()]);
  const user = await database.user.create({
    data: {
      googleSubject: `load-subject-${testRun}`,
      email: ownerEmail,
      name: "Load Proof",
      lastLoginAt: new Date(),
    },
  });
  ownerId = user.id;
  const sender = await database.emailSender.create({
    data: {
      userId: user.id,
      displayName: "Load Sender",
      email: ownerEmail,
      normalizedEmail: ownerEmail,
      isDefault: true,
      hourlyLimit: emailCount,
      minimumDelayMs: 0,
    },
  });
  const batch = await database.emailBatch.create({
    data: {
      userId: user.id,
      senderId: sender.id,
      idempotencyKey: `load-batch-${testRun}`,
      subject: "One thousand job proof",
      bodyText: "Fake SMTP body",
      startAt: new Date(),
      requestedHourlyLimit: emailCount,
      requestedMinimumDelayMs: 0,
      sourceFilename: "load-proof.txt",
      totalRows: emailCount,
      validRecipientCount: emailCount,
      invalidRecipientCount: 0,
      duplicateRecipientCount: 0,
      status: "SCHEDULED",
    },
  });
  batchId = batch.id;

  await database.scheduledEmail.createMany({
    data: Array.from({ length: emailCount }, (_, sequenceNumber) => {
      const id = randomUUID();
      return {
        id,
        batchId,
        senderId: sender.id,
        recipientEmail: `load-${sequenceNumber}-${testRun}@example.com`,
        normalizedRecipientEmail: `load-${sequenceNumber}-${testRun}@example.com`,
        sequenceNumber,
        scheduledAt: new Date(),
        nextAttemptAt: new Date(),
        bullJobId: `email_${id}`,
        idempotencyKey: `load-email-${sequenceNumber}-${testRun}`,
      };
    }),
  });
}, 30_000);

afterAll(async () => {
  await Promise.all(workers.map(async (worker) => worker.close()));
  await queue.obliterate({ force: true });
  await queue.close();
  const redisKeys = await redis.keys(`${config.BULLMQ_PREFIX}:*`);
  if (redisKeys.length > 0) await redis.del(...redisKeys);
  await redis.quit();
  await database.scheduledEmail.deleteMany({ where: { batchId } });
  await database.emailBatch.deleteMany({ where: { userId: ownerId } });
  await database.emailSender.deleteMany({ where: { userId: ownerId } });
  await database.user.delete({ where: { id: ownerId } });
  await database.$disconnect();
}, 30_000);

describe("1,000-job reliability proof", () => {
  it("recovers missing jobs and accepts every email at most once across two workers", async () => {
    await enqueueEmailBatch(queue, database, batchId, config);
    const initialJobs = await queue.getWaiting(0, 24);
    expect(initialJobs).toHaveLength(25);
    const removedJobIds = initialJobs.flatMap((job) => (job.id === undefined ? [] : [job.id]));
    expect(removedJobIds).toHaveLength(25);
    await Promise.all(initialJobs.map(async (job) => job.remove()));

    await enqueueEmailBatch(queue, database, batchId, config);
    await enqueueEmailBatch(queue, database, batchId, config);
    for (const jobId of removedJobIds) {
      expect(await queue.getJob(jobId)).not.toBeNull();
    }

    const limiter = new SenderRateLimiter(redis, config);
    for (let index = 0; index < 2; index += 1) {
      const worker = createEmailWorker(
        config,
        createEmailProcessor(database, limiter, mailer, config),
      );
      worker.on("error", (error) => workerErrors.push(error));
      workers.push(worker);
    }

    await waitForTerminalRows();

    const rows = await database.scheduledEmail.findMany({
      where: { batchId },
      select: { attemptCount: true, status: true },
    });
    const terminalCount = rows.filter((row) =>
      ["SENT", "FAILED", "DELIVERY_UNKNOWN", "CANCELLED"].includes(row.status),
    ).length;
    const genuinelyPendingCount = rows.length - terminalCount;
    const acceptedAttempts = await database.sendAttempt.groupBy({
      by: ["scheduledEmailId"],
      where: { scheduledEmail: { batchId }, outcome: "SMTP_ACCEPTED" },
      _count: { _all: true },
    });
    const completedBatch = await database.emailBatch.findUniqueOrThrow({
      where: { id: batchId },
      select: { status: true },
    });

    expect(rows).toHaveLength(emailCount);
    expect(terminalCount + genuinelyPendingCount).toBe(emailCount);
    expect(genuinelyPendingCount).toBe(0);
    expect(rows.every((row) => row.status === "SENT" && row.attemptCount === 1)).toBe(true);
    expect(acceptedAttempts).toHaveLength(emailCount);
    expect(acceptedAttempts.every((attempt) => attempt._count._all === 1)).toBe(true);
    expect(acceptanceCounts.size).toBe(emailCount);
    expect([...acceptanceCounts.values()].every((count) => count === 1)).toBe(true);
    expect(maximumActiveSends).toBeGreaterThan(1);
    expect(workerErrors).toEqual([]);
    expect(completedBatch.status).toBe("COMPLETED");
  }, 120_000);
});
