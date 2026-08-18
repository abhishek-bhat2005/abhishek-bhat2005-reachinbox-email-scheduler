import type { Request, RequestHandler } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { createPrismaClient } from "../../src/db/prisma.js";
import { createEmailRouter } from "../../src/email/router.js";

const databaseUrl = process.env["DATABASE_URL"];
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required for integration tests");
}

const database = createPrismaClient(databaseUrl);
const testRun = crypto.randomUUID();
const ownerEmail = `owner-${testRun}@example.com`;
const otherEmail = `other-${testRun}@example.com`;
const apiConfig = {
  API_MAX_PAGE_SIZE: 200,
  API_PAGE_SIZE: 50,
  DEFAULT_EMAILS_PER_HOUR: 100,
  DEFAULT_MIN_SEND_DELAY_MS: 1_000,
  MAX_BODY_LENGTH: 100_000,
  MAX_EMAILS_PER_HOUR: 10_000,
  MAX_LEADS_PER_BATCH: 10_000,
  MAX_SCHEDULE_HORIZON_DAYS: 365,
  MAX_SEND_DELAY_MS: 60_000,
  MAX_SUBJECT_LENGTH: 255,
  MAX_UPLOAD_BYTES: 5_242_880,
  MIN_SEND_DELAY_MS: 100,
};

let owner: Express.User;
let other: Express.User;
let senderId: string;

function authenticatedApp(user: Express.User, config = apiConfig) {
  function isAuthenticated(this: Request): this is Express.AuthenticatedRequest {
    return this.user !== undefined;
  }

  const authenticate: RequestHandler = (request, _response, next) => {
    request.user = user;
    request.isAuthenticated = isAuthenticated;
    next();
  };

  return createApp(
    {
      healthChecks: {
        database: async () => Promise.resolve(),
        redis: async () => Promise.resolve(),
      },
    },
    (app) => {
      app.use(authenticate);
      app.use(
        "/api",
        createEmailRouter({ config, database, enqueueBatch: async () => Promise.resolve() }),
      );
    },
  );
}

function scheduleRequest(app: ReturnType<typeof authenticatedApp>, idempotencyKey: string) {
  const csv = ["email"];
  for (let index = 0; index < 1_000; index += 1) {
    csv.push(`lead-${testRun}-${index}@example.com`);
  }

  return request(app)
    .post("/api/email-batches")
    .set("Idempotency-Key", idempotencyKey)
    .field("senderId", senderId)
    .field("subject", "Integration load test")
    .field("body", "Plain-text integration body")
    .field("startAt", new Date(Date.now() + 60_000).toISOString())
    .field("minimumDelayMs", "100")
    .field("hourlyLimit", "1000")
    .attach("leadsFile", Buffer.from(csv.join("\n")), {
      filename: "leads.csv",
      contentType: "text/csv",
    });
}

beforeAll(async () => {
  await database.$connect();
  const savedOwner = await database.user.create({
    data: {
      googleSubject: `subject-owner-${testRun}`,
      email: ownerEmail,
      name: "Integration Owner",
      lastLoginAt: new Date(),
    },
  });
  const savedOther = await database.user.create({
    data: {
      googleSubject: `subject-other-${testRun}`,
      email: otherEmail,
      name: "Integration Other",
      lastLoginAt: new Date(),
    },
  });
  const sender = await database.emailSender.create({
    data: {
      userId: savedOwner.id,
      displayName: "Integration Sender",
      email: ownerEmail,
      normalizedEmail: ownerEmail,
      isDefault: true,
      hourlyLimit: 100,
      minimumDelayMs: 1_000,
    },
  });

  owner = { id: savedOwner.id, email: savedOwner.email, name: savedOwner.name, avatarUrl: null };
  other = { id: savedOther.id, email: savedOther.email, name: savedOther.name, avatarUrl: null };
  senderId = sender.id;
});

afterAll(async () => {
  await database.scheduledEmail.deleteMany({
    where: { batch: { userId: { in: [owner.id, other.id] } } },
  });
  await database.emailBatch.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
  await database.emailSender.deleteMany({ where: { userId: { in: [owner.id, other.id] } } });
  await database.user.deleteMany({ where: { email: { in: [ownerEmail, otherEmail] } } });
  await database.$disconnect();
});

describe("email scheduling API", () => {
  it("creates exactly 1,000 durable rows and replays the idempotent request", async () => {
    const app = authenticatedApp(owner);
    const idempotencyKey = `integration-${testRun}`;
    const created = await scheduleRequest(app, idempotencyKey);

    expect(created.status).toBe(201);
    expect(created.body.replayed).toBe(false);
    expect(created.body.batch.validRecipientCount).toBe(1_000);

    const batchId = created.body.batch.id as string;
    expect(await database.scheduledEmail.count({ where: { batchId } })).toBe(1_000);
    expect(
      await database.scheduledEmail.count({
        where: { batchId, bullJobId: { startsWith: "email_" } },
      }),
    ).toBe(1_000);

    const replayed = await scheduleRequest(app, idempotencyKey);
    expect(replayed.status).toBe(200);
    expect(replayed.body.replayed).toBe(true);
    expect(replayed.body.batch.id).toBe(batchId);
    expect(await database.emailBatch.count({ where: { userId: owner.id, idempotencyKey } })).toBe(
      1,
    );
    expect(await database.scheduledEmail.count({ where: { batchId } })).toBe(1_000);

    const firstPage = await request(app).get("/api/emails/scheduled?limit=200");
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.items).toHaveLength(200);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));

    const progress = await request(app).get(`/api/email-batches/${batchId}`);
    expect(progress.status).toBe(200);
    expect(progress.body.batch.counts.byStatus.scheduled).toBe(1_000);

    const hiddenFromOtherUser = await request(authenticatedApp(other)).get(
      `/api/email-batches/${batchId}`,
    );
    expect(hiddenFromOtherUser.status).toBe(404);
  }, 30_000);

  it("rejects scheduling with another user's sender", async () => {
    const response = await scheduleRequest(authenticatedApp(other), `foreign-${testRun}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("SENDER_NOT_FOUND");
    expect(
      await database.emailBatch.count({
        where: { userId: other.id, idempotencyKey: `foreign-${testRun}` },
      }),
    ).toBe(0);
  });

  it("enforces upload byte limits through the multipart boundary", async () => {
    const response = await request(authenticatedApp(owner, { ...apiConfig, MAX_UPLOAD_BYTES: 10 }))
      .post("/api/email-batches")
      .set("Idempotency-Key", `oversized-${testRun}`)
      .field("senderId", senderId)
      .field("subject", "Oversized")
      .field("body", "Body")
      .field("startAt", new Date(Date.now() + 60_000).toISOString())
      .field("minimumDelayMs", "100")
      .field("hourlyLimit", "100")
      .attach("leadsFile", Buffer.from("lead@example.com"), {
        filename: "leads.txt",
        contentType: "text/plain",
      });

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe("UPLOAD_TOO_LARGE");
  });

  it("creates and updates owned sender policies while protecting defaults", async () => {
    const ownerApp = authenticatedApp(owner);
    const created = await request(ownerApp)
      .post("/api/senders")
      .send({
        displayName: "Second Sender",
        email: `second-${testRun}@example.com`,
        isDefault: true,
        hourlyLimit: 250,
        minimumDelayMs: 500,
      });

    expect(created.status).toBe(201);
    expect(created.body.sender.isDefault).toBe(true);
    expect(
      await database.emailSender.findUnique({
        where: { id: senderId },
        select: { isDefault: true },
      }),
    ).toEqual({ isDefault: false });

    const newSenderId = created.body.sender.id as string;
    const deactivateDefault = await request(ownerApp)
      .patch(`/api/senders/${newSenderId}`)
      .send({ isActive: false });
    expect(deactivateDefault.status).toBe(409);

    const crossUserUpdate = await request(authenticatedApp(other))
      .patch(`/api/senders/${newSenderId}`)
      .send({ displayName: "Not allowed" });
    expect(crossUserUpdate.status).toBe(404);
  });
});
