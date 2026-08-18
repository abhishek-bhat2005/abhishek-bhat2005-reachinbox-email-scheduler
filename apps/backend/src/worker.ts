import { loadConfig } from "./config/env.js";
import { createPrismaClient } from "./db/prisma.js";
import { createEmailQueue } from "./queue/email-queue.js";
import { reconcileEmailQueue } from "./queue/reconcile.js";

async function prepareWorker(): Promise<void> {
  const config = loadConfig();
  const database = createPrismaClient(config.DATABASE_URL);
  const queue = createEmailQueue(config);

  try {
    const result = await reconcileEmailQueue(queue, database, config);
    console.info(
      { examined: result.examined, deliveryUnknown: result.deliveryUnknown },
      "Email queue reconciliation completed",
    );
  } finally {
    await Promise.allSettled([queue.close(), database.$disconnect()]);
  }
}

void prepareWorker().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Worker preparation failed");
  process.exitCode = 1;
});
