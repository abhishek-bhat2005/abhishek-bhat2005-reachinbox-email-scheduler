import session from "express-session";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RedisSessionStore } from "../../src/auth/redis-session-store.js";
import { createRedisClient } from "../../src/redis/client.js";

const redisUrl = process.env["REDIS_URL"];

if (redisUrl === undefined) {
  throw new Error("REDIS_URL is required for integration tests");
}

const redis = createRedisClient(redisUrl, "integration-session-store");
const keyPrefix = "integration-session:";
const store = new RedisSessionStore(redis, keyPrefix, 60_000);
const sessionId = "session-store-test";

beforeAll(async () => {
  await redis.connect();
  await redis.del(`${keyPrefix}${sessionId}`);
});

afterAll(async () => {
  await redis.del(`${keyPrefix}${sessionId}`);
  await redis.quit();
});

describe("Redis session store", () => {
  it("persists, reads, touches, and destroys a session", async () => {
    const cookie = new session.Cookie();
    cookie.maxAge = 60_000;
    const sessionData: session.SessionData = {
      cookie,
    };

    await new Promise<void>((resolve, reject) => {
      store.set(sessionId, sessionData, (error) => (error ? reject(error) : resolve()));
    });

    const loaded = await new Promise<session.SessionData | null | undefined>((resolve, reject) => {
      store.get(sessionId, (error, value) => (error ? reject(error) : resolve(value)));
    });
    expect(loaded?.cookie).toBeDefined();

    await new Promise<void>((resolve, reject) => {
      store.touch(sessionId, sessionData, (error) => (error ? reject(error) : resolve()));
    });

    await new Promise<void>((resolve, reject) => {
      store.destroy(sessionId, (error) => (error ? reject(error) : resolve()));
    });

    expect(await redis.exists(`${keyPrefix}${sessionId}`)).toBe(0);
  });
});
