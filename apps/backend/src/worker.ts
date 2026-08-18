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
import { createLogger, errorName } from "./observability/logger.js";

async function startWorker(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config, "email-worker");
  const database = createPrismaClient(config.DATABASE_URL);
  const redis = createRedisClient(config.REDIS_URL, "worker-rate-limit");
  const queue = createEmailQueue(config);
  const mailer = createSmtpMailer(config);

  try {
    await Promise.all([database.$connect(), redis.connect()]);
    const rateLimiter = new SenderRateLimiter(redis, config);
    const seededSenders = await seedSenderRateLimits(database, rateLimiter);
    const result = await reconcileEmailQueue(queue, database, config);
    logger.info("Email worker startup completed", {
      examined: result.examined,
      deliveryUnknown: result.deliveryUnknown,
      seededSenders,
      concurrency: config.WORKER_CONCURRENCY,
    });

    const worker = createEmailWorker(
      config,
      createEmailProcessor(database, rateLimiter, mailer, config),
    );
    worker.on("error", (error) => {
      logger.error("Email worker internal error", { errorName: errorName(error) });
    });
    worker.on("failed", (job, error) => {
      logger.warn("Email job failed", {
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        errorName: errorName(error),
      });
    });

    let shutdownStarted = false;
    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
      if (shutdownStarted) return;
      shutdownStarted = true;
      logger.info("Email worker shutdown started", { signal });
      await worker.close();
      mailer.close();
      await Promise.allSettled([queue.close(), database.$disconnect(), redis.quit()]);
      logger.info("Email worker shutdown completed");
    };

    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  } catch (error) {
    mailer.close();
    await Promise.allSettled([queue.close(), database.$disconnect(), redis.quit()]);
    throw error;
  }
}

void startWorker().catch((error: unknown) => {
  const fallbackLogger = createLogger({ LOG_LEVEL: "error" }, "email-worker");
  fallbackLogger.fatal("Email worker startup failed", { errorName: errorName(error) });
  process.exitCode = 1;
});
