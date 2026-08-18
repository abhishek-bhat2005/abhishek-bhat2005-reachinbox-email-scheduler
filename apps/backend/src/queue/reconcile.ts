import type { AppConfig } from "../config/env.js";
import type { DatabaseClient } from "../db/prisma.js";
import { enqueueEmailRows, type EmailQueue } from "./email-queue.js";

type ReconciliationConfig = Pick<AppConfig, "PROCESSING_LEASE_MS" | "RECONCILIATION_BATCH_SIZE">;

export interface ReconciliationResult {
  deliveryUnknown: number;
  examined: number;
}

export async function reconcileEmailQueue(
  queue: EmailQueue,
  database: DatabaseClient,
  config: ReconciliationConfig,
  now = new Date(),
): Promise<ReconciliationResult> {
  const staleBefore = new Date(now.getTime() - config.PROCESSING_LEASE_MS);
  const stale = await database.scheduledEmail.updateMany({
    where: {
      status: "PROCESSING",
      processingStartedAt: { lt: staleBefore },
    },
    data: {
      status: "DELIVERY_UNKNOWN",
      processingToken: null,
      lastErrorCode: "STALE_PROCESSING_LEASE",
      lastErrorMessage: "Delivery outcome is unknown after worker interruption",
    },
  });

  let cursor: string | undefined;
  let examined = 0;

  while (true) {
    const emails = await database.scheduledEmail.findMany({
      where: { status: { in: ["SCHEDULED", "RATE_LIMITED", "RETRYABLE"] } },
      select: { id: true, bullJobId: true, nextAttemptAt: true },
      orderBy: { id: "asc" },
      take: config.RECONCILIATION_BATCH_SIZE,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });

    await enqueueEmailRows(queue, emails, now);
    examined += emails.length;

    const last = emails.at(-1);
    if (last === undefined || emails.length < config.RECONCILIATION_BATCH_SIZE) {
      break;
    }
    cursor = last.id;
  }

  return { deliveryUnknown: stale.count, examined };
}
