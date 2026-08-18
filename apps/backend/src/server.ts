import { createApp } from "./app.js";
import { setupAuth } from "./auth/setup-auth.js";
import { loadConfig } from "./config/env.js";
import { createPrismaClient } from "./db/prisma.js";
import { createEmailRouter } from "./email/router.js";
import { createEmailQueue, enqueueEmailBatch } from "./queue/email-queue.js";
import { createRedisClient } from "./redis/client.js";
import { createLogger, errorName } from "./observability/logger.js";

const config = loadConfig();
const logger = createLogger(config, "api");
const database = createPrismaClient(config.DATABASE_URL);
const redis = createRedisClient(config.REDIS_URL, "api");
const emailQueue = createEmailQueue(config);

const app = createApp(
  {
    healthChecks: {
      database: async () => database.$queryRaw`SELECT 1`,
      redis: async () => redis.ping(),
    },
    onInternalError: (error) =>
      logger.error("Unhandled API request error", { errorName: errorName(error) }),
  },
  (expressApp) => {
    setupAuth(expressApp, { config, database, redis });
    expressApp.use(
      "/api",
      createEmailRouter({
        config,
        database,
        enqueueBatch: async (batchId) => enqueueEmailBatch(emailQueue, database, batchId, config),
      }),
    );
  },
);

const server = app.listen(config.BACKEND_PORT, config.BACKEND_HOST, () => {
  logger.info("Backend is listening", { host: config.BACKEND_HOST, port: config.BACKEND_PORT });
});

server.on("error", (error) => {
  logger.fatal("Backend server error", { errorName: error.name });
});

let shutdownStarted = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) {
    return;
  }

  shutdownStarted = true;
  logger.info("Backend shutdown started", { signal });

  server.close(async () => {
    await Promise.allSettled([emailQueue.close(), database.$disconnect(), redis.quit()]);
    logger.info("Backend shutdown completed");
    process.exitCode = 0;
  });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
