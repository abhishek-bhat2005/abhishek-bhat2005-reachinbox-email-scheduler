import { Worker, type Job, type Processor } from "bullmq";

import type { AppConfig } from "../config/env.js";
import { bullMqConnection, emailJobName, type EmailJobData } from "./email-queue.js";

type WorkerConfig = Pick<
  AppConfig,
  "BULLMQ_PREFIX" | "EMAIL_QUEUE_NAME" | "REDIS_URL" | "WORKER_CONCURRENCY"
>;

export type EmailJob = Job<EmailJobData, void, typeof emailJobName>;
export type EmailJobProcessor = Processor<EmailJobData, void, typeof emailJobName>;

export function createEmailWorker(
  config: WorkerConfig,
  processor: EmailJobProcessor,
): Worker<EmailJobData, void, typeof emailJobName> {
  return new Worker<EmailJobData, void, typeof emailJobName>(config.EMAIL_QUEUE_NAME, processor, {
    connection: bullMqConnection(config, "email-worker"),
    concurrency: config.WORKER_CONCURRENCY,
    prefix: config.BULLMQ_PREFIX,
  });
}
