import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { createPrismaClient } from "../../src/db/prisma.js";
import { createRedisClient } from "../../src/redis/client.js";

const databaseUrl = process.env["DATABASE_URL"];
const redisUrl = process.env["REDIS_URL"];

if (databaseUrl === undefined || redisUrl === undefined) {
  throw new Error("DATABASE_URL and REDIS_URL are required for integration tests");
}

const database = createPrismaClient(databaseUrl);
const redis = createRedisClient(redisUrl, "integration-health");

const app = createApp({
  healthChecks: {
    database: async () => database.$queryRaw`SELECT 1`,
    redis: async () => redis.ping(),
  },
});

beforeAll(async () => {
  await Promise.all([database.$connect(), redis.connect()]);
});

afterAll(async () => {
  await Promise.all([database.$disconnect(), redis.quit()]);
});

describe("dependency readiness", () => {
  it("reports ready against real PostgreSQL and Redis services", async () => {
    const response = await request(app).get("/api/health/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ready" });
  });
});
