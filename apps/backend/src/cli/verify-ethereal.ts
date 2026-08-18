import { randomUUID } from "node:crypto";

import { loadConfig } from "../config/env.js";
import { createPrismaClient } from "../db/prisma.js";
import { createSmtpMailer } from "../email/mailer.js";
import { createEmailBatch } from "../email/scheduling-service.js";
import { createEmailQueue, enqueueEmailBatch } from "../queue/email-queue.js";
import { createEmailWorker } from "../queue/email-worker.js";
import { reconcileEmailQueue } from "../queue/reconcile.js";
import { SenderRateLimiter } from "../rate-limit/sender-rate-limiter.js";
import { createRedisClient } from "../redis/client.js";
import { createEmailProcessor } from "../worker/email-processor.js";
import { seedSenderRateLimits } from "../worker/rate-seed.js";

async function waitForTerminalStatus(
  database: ReturnType<typeof createPrismaClient>,
  batchId: string,
) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const email = await database.scheduledEmail.findFirst({ where: { batchId } });
    if (
      email !== null &&
      ["SENT", "FAILED", "DELIVERY_UNKNOWN", "CANCELLED"].includes(email.status)
    ) {
      return email;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Ethereal delivery");
}

async function verifyEthereal(): Promise<void> {
  const config = loadConfig();
  if (config.SMTP_USER.startsWith("PENDING_") || config.SMTP_PASSWORD.startsWith("PENDING_")) {
    throw new Error("Configure the Ethereal SMTP credentials in .env first");
  }

  const database = createPrismaClient(config.DATABASE_URL);
  const redis = createRedisClient(config.REDIS_URL, "verify-ethereal");
  const queue = createEmailQueue(config);
  const mailer = createSmtpMailer(config);
  let worker: ReturnType<typeof createEmailWorker> | undefined;

  try {
    await Promise.all([database.$connect(), redis.connect()]);
    const sender = await database.emailSender.findFirst({
      where: { isActive: true },
      include: { user: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
    if (sender === null) {
      throw new Error("Sign in with Google once before running Ethereal verification");
    }

    const idempotencyKey = `ethereal-verification-${randomUUID()}`;
    const result = await createEmailBatch(database, {
      userId: sender.userId,
      senderId: sender.id,
      idempotencyKey,
      subject: "ReachInbox Ethereal verification",
      bodyText: "This message verifies the durable BullMQ and Ethereal delivery pipeline.",
      startAt: new Date(Date.now() + sender.minimumDelayMs),
      hourlyLimit: sender.hourlyLimit,
      minimumDelayMs: sender.minimumDelayMs,
      sourceFilename: "ethereal-verification.txt",
      parsedLeads: {
        leads: [{ email: sender.user.email, normalizedEmail: sender.user.email }],
        totalRows: 1,
        invalidCount: 0,
        duplicateCount: 0,
        invalidRows: [],
      },
    });

    const rateLimiter = new SenderRateLimiter(redis, config);
    await seedSenderRateLimits(database, rateLimiter);
    await enqueueEmailBatch(queue, database, result.batch.id, config);
    await reconcileEmailQueue(queue, database, config);
    worker = createEmailWorker(config, createEmailProcessor(database, rateLimiter, mailer, config));
    worker.on("error", () => undefined);

    const email = await waitForTerminalStatus(database, result.batch.id);
    console.info(
      JSON.stringify({
        status: email.status.toLowerCase(),
        previewUrl: email.etherealPreviewUrl,
        errorCode: email.lastErrorCode,
      }),
    );

    if (email.status !== "SENT") process.exitCode = 1;
  } finally {
    if (worker !== undefined) await worker.close();
    mailer.close();
    await Promise.allSettled([queue.close(), redis.quit(), database.$disconnect()]);
  }
}

void verifyEthereal().catch((error: unknown) => {
  void error;
  console.error("Ethereal verification failed; check the local SMTP configuration and services");
  process.exitCode = 1;
});
