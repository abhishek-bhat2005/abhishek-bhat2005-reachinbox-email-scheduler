import type { DatabaseClient } from "../db/prisma.js";
import { currentHourStart, type SenderRateLimiter } from "../rate-limit/sender-rate-limiter.js";

export async function seedSenderRateLimits(
  database: DatabaseClient,
  rateLimiter: SenderRateLimiter,
  now = new Date(),
): Promise<number> {
  const senders = await database.emailSender.findMany({
    where: { isActive: true },
    select: { id: true, hourlyLimit: true, minimumDelayMs: true },
  });
  const hourStart = currentHourStart(now);

  for (const sender of senders) {
    const accepted = await database.scheduledEmail.aggregate({
      where: {
        senderId: sender.id,
        status: "SENT",
        sentAt: { gte: hourStart, lte: now },
      },
      _count: { id: true },
      _max: { sentAt: true },
    });

    await rateLimiter.seed(
      {
        senderId: sender.id,
        hourlyLimit: sender.hourlyLimit,
        minimumDelayMs: sender.minimumDelayMs,
      },
      accepted._count.id,
      accepted._max.sentAt,
      now,
    );
  }

  return senders.length;
}
