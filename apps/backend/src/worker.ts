import { loadConfig } from "./config/env.js";
import { createPrismaClient } from "./db/prisma.js";
import { createSmtpMailer } from "./email/mailer.js";
import { createEmailQueue } from "./queue/email-queue.js";
import { createEmailWorker } from "./queue/email-worker.js";
import { reconcileEmailQueue } from "./queue/reconcile.js";
import { SenderRateLimiter } from "./rate-limit/sender-rate-limiter.js";
import { createRedisClient } from "./redis/client.js";
import { createEmailProcessor } from "./worker/email-processor.js";
import { seedSenderRateLimits } from "./worker/rate-seed.js";

async function startWorker(): Promise<void> {
  const config = loadConfig();
  const database = createPrismaClient(config.DATABASE_URL);
  const redis = createRedisClient(config.REDIS_URL, "worker-rate-limit");
  const queue = createEmailQueue(config);
  const mailer = createSmtpMailer(config);

  try {
    await Promise.all([database.$connect(), redis.connect()]);
    const rateLimiter = new SenderRateLimiter(redis, config);
    const seededSenders = await seedSenderRateLimits(database, rateLimiter);
    const result = await reconcileEmailQueue(queue, database, config);
    console.info(
      {
        examined: result.examined,
        deliveryUnknown: result.deliveryUnknown,
        seededSenders,
      },
      "Email worker startup completed",
    );

    const worker = createEmailWorker(
      config,
      createEmailProcessor(database, rateLimiter, mailer, config),
    );
    worker.on("error", () => {
      console.error("The email worker reported an internal error");
    });

    let shutdownStarted = false;
    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
      if (shutdownStarted) return;
      shutdownStarted = true;
      console.info({ signal }, "Email worker shutdown started");
      await worker.close();
      mailer.close();
      await Promise.allSettled([queue.close(), database.$disconnect(), redis.quit()]);
    };

    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  } catch (error) {
    mailer.close();
    await Promise.allSettled([queue.close(), database.$disconnect(), redis.quit()]);
    throw error;
  }
}

void startWorker().catch(() => {
  console.error("Email worker startup failed");
  process.exitCode = 1;
});
