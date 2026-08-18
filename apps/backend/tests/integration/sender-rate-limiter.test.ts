import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SenderRateLimiter } from "../../src/rate-limit/sender-rate-limiter.js";
import { createRedisClient } from "../../src/redis/client.js";

const redisUrl = process.env["REDIS_URL"];
if (redisUrl === undefined) {
  throw new Error("REDIS_URL is required for integration tests");
}

const testRun = randomUUID();
const prefix = `rate-limit-test-${testRun}`;
const redis = createRedisClient(redisUrl, "integration-rate-limit");
const limiter = new SenderRateLimiter(redis, {
  BULLMQ_PREFIX: prefix,
  RATE_LIMIT_RESERVATION_TTL_MS: 7_200_000,
});

beforeAll(async () => redis.connect());

afterAll(async () => {
  const keys = await redis.keys(`${prefix}:*`);
  if (keys.length > 0) await redis.del(...keys);
  await redis.quit();
});

describe("atomic per-sender rate limiting", () => {
  it("admits exactly the hourly quota under concurrency and preserves reservations", async () => {
    const senderId = randomUUID();
    const now = new Date();
    const decisions = await Promise.all(
      Array.from({ length: 20 }, async () =>
        limiter.reserve({ senderId, hourlyLimit: 3, minimumDelayMs: 0 }, randomUUID(), now),
      ),
    );

    expect(decisions.filter((decision) => decision.admitted)).toHaveLength(3);
    expect(decisions.filter((decision) => !decision.admitted)).toHaveLength(17);

    const reservedEmailId = randomUUID();
    const reservedSenderId = randomUUID();
    const first = await limiter.reserve(
      { senderId: reservedSenderId, hourlyLimit: 1, minimumDelayMs: 0 },
      reservedEmailId,
      now,
    );
    const replay = await limiter.reserve(
      { senderId: reservedSenderId, hourlyLimit: 1, minimumDelayMs: 0 },
      reservedEmailId,
      now,
    );
    const differentEmail = await limiter.reserve(
      { senderId: reservedSenderId, hourlyLimit: 1, minimumDelayMs: 0 },
      randomUUID(),
      now,
    );

    expect(first.admitted).toBe(true);
    expect(replay).toMatchObject({ admitted: true, existingReservation: true });
    expect(differentEmail.admitted).toBe(false);
  });

  it("enforces minimum spacing independently for different senders", async () => {
    const now = new Date();
    const senderOne = randomUUID();
    const senderTwo = randomUUID();
    const policy = { hourlyLimit: 10, minimumDelayMs: 500 };

    const first = await limiter.reserve({ ...policy, senderId: senderOne }, randomUUID(), now);
    const tooSoon = await limiter.reserve({ ...policy, senderId: senderOne }, randomUUID(), now);
    const independent = await limiter.reserve(
      { ...policy, senderId: senderTwo },
      randomUUID(),
      now,
    );
    const afterSpacing = await limiter.reserve(
      { ...policy, senderId: senderOne },
      randomUUID(),
      new Date(now.getTime() + policy.minimumDelayMs),
    );

    expect(first.admitted).toBe(true);
    expect(tooSoon.admitted).toBe(false);
    expect(tooSoon.nextAvailableAt.getTime()).toBe(now.getTime() + policy.minimumDelayMs);
    expect(independent.admitted).toBe(true);
    expect(afterSpacing.admitted).toBe(true);
  });
});
