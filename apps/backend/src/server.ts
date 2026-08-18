import { createApp } from "./app.js";
import { setupAuth } from "./auth/setup-auth.js";
import { loadConfig } from "./config/env.js";
import { createPrismaClient } from "./db/prisma.js";
import { createEmailRouter } from "./email/router.js";
import { createRedisClient } from "./redis/client.js";

const config = loadConfig();
const database = createPrismaClient(config.DATABASE_URL);
const redis = createRedisClient(config.REDIS_URL, "api");

const app = createApp(
  {
    healthChecks: {
      database: async () => database.$queryRaw`SELECT 1`,
      redis: async () => redis.ping(),
    },
  },
  (expressApp) => {
    setupAuth(expressApp, { config, database, redis });
    expressApp.use("/api", createEmailRouter({ config, database }));
  },
);

const server = app.listen(config.BACKEND_PORT, config.BACKEND_HOST, () => {
  console.info("Backend is listening on the configured host and port");
});

let shutdownStarted = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) {
    return;
  }

  shutdownStarted = true;
  console.info({ signal }, "Backend shutdown started");

  server.close(async () => {
    await Promise.allSettled([database.$disconnect(), redis.quit()]);
    process.exitCode = 0;
  });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
