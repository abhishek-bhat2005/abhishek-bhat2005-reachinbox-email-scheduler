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

const testRun = randomUUID();
const testEmail = `worker-${testRun}@example.com`;
const database = createPrismaClient(databaseUrl);
const redis = createRedisClient(redisUrl, "integration-email-worker");
const config = {
  BULLMQ_PREFIX: `worker-test-${testRun}`,
  EMAIL_QUEUE_NAME: "email-worker-test",
  JOB_RETENTION_COUNT: 100,
  RATE_LIMIT_RESERVATION_TTL_MS: 7_200_000,
  RECONCILIATION_BATCH_SIZE: 100,
  REDIS_URL: redisUrl,
  SMTP_BACKOFF_MS: 100,
  SMTP_MAX_ATTEMPTS: 2,
  WORKER_CONCURRENCY: 3,
};
const queue = createEmailQueue(config);
const sendTimes: Date[] = [];
const sentIds: string[] = [];
const mailer: Mailer = {
  async send(message) {
    sendTimes.push(new Date());
    sentIds.push(message.scheduledEmailId);
    return {
      messageId: `<${message.scheduledEmailId}@test.invalid>`,
      previewUrl: `https://example.invalid/message/${message.scheduledEmailId}`,
      acceptedCount: 1,
      rejectedCount: 0,
    };
  },
  close() {
    return undefined;
  },
};

let ownerId: string;
let batchId: string;
let worker: ReturnType<typeof createEmailWorker> | undefined;

async function waitForControlledBacklog(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const grouped = await database.scheduledEmail.groupBy({
      by: ["status"],
      where: { batchId },
      _count: { _all: true },
    });
    const counts = Object.fromEntries(grouped.map((row) => [row.status, row._count._all]));
    if (counts["SENT"] === 2 && counts["RATE_LIMITED"] === 1) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the controlled worker backlog");
}

beforeAll(async () => {
  await Promise.all([database.$connect(), redis.connect()]);
  const user = await database.user.create({
    data: {
      googleSubject: `worker-subject-${testRun}`,
      email: testEmail,
      name: "Worker Integration",
      lastLoginAt: new Date(),
    },
  });
  ownerId = user.id;
  const sender = await database.emailSender.create({
    data: {
      userId: user.id,
      displayName: "Worker Sender",
      email: testEmail,
      normalizedEmail: testEmail,
      isDefault: true,
      hourlyLimit: 2,
      minimumDelayMs: 100,
    },
  });
  const batch = await database.emailBatch.create({
    data: {
      userId: user.id,
      senderId: sender.id,
      idempotencyKey: `worker-batch-${testRun}`,
      subject: "Worker integration",
      bodyText: "Worker integration body",
      startAt: new Date(),
      requestedHourlyLimit: 2,
      requestedMinimumDelayMs: 100,
      sourceFilename: "worker-test.txt",
      totalRows: 3,
      validRecipientCount: 3,
      invalidRecipientCount: 0,
      duplicateRecipientCount: 0,
      status: "SCHEDULED",
    },
  });
  batchId = batch.id;
  await database.scheduledEmail.createMany({
    data: Array.from({ length: 3 }, (_, sequenceNumber) => {
      const id = randomUUID();
      return {
        id,
        batchId: batch.id,
        senderId: sender.id,
        recipientEmail: `worker-lead-${sequenceNumber}-${testRun}@example.com`,
        normalizedRecipientEmail: `worker-lead-${sequenceNumber}-${testRun}@example.com`,
        sequenceNumber,
        scheduledAt: new Date(),
        nextAttemptAt: new Date(),
        bullJobId: `email_${id}`,
        idempotencyKey: `worker-email-${sequenceNumber}-${testRun}`,
      };
    }),
  });
});

afterAll(async () => {
  if (worker !== undefined) await worker.close();
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
});

describe("email worker", () => {
  it("enforces spacing and quota while rescheduling overflow without consuming retries", async () => {
    await enqueueEmailBatch(queue, database, batchId, config);
    await enqueueEmailBatch(queue, database, batchId, config);

    const limiter = new SenderRateLimiter(redis, config);
    worker = createEmailWorker(config, createEmailProcessor(database, limiter, mailer, config));
    worker.on("error", () => undefined);

    await waitForControlledBacklog();

    expect(sentIds).toHaveLength(2);
    expect(new Set(sentIds).size).toBe(2);
    const orderedTimes = sendTimes
      .map((value) => value.getTime())
      .sort((left, right) => left - right);
    expect((orderedTimes[1] ?? 0) - (orderedTimes[0] ?? 0)).toBeGreaterThanOrEqual(90);

    const deferred = await database.scheduledEmail.findFirstOrThrow({
      where: { batchId, status: "RATE_LIMITED" },
    });
    expect(deferred.rateLimitedUntil?.getTime()).toBeGreaterThan(Date.now());
    const deferredJob = await queue.getJob(deferred.bullJobId);
    expect(await deferredJob?.getState()).toBe("delayed");
    expect(deferredJob?.attemptsMade).toBe(0);

    const acceptedAttempts = await database.sendAttempt.count({
      where: { scheduledEmail: { batchId }, outcome: "SMTP_ACCEPTED" },
    });
    expect(acceptedAttempts).toBe(2);
  }, 15_000);
});
