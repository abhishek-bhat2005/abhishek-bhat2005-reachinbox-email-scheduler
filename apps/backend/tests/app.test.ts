import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

const passingHealthChecks = {
  database: async () => Promise.resolve(),
  redis: async () => Promise.resolve(),
};

describe("health endpoints", () => {
  it("reports liveness without checking dependencies", async () => {
    const response = await request(createApp({ healthChecks: passingHealthChecks })).get(
      "/api/health/live",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "alive" });
  });

  it("reports readiness when PostgreSQL and Redis respond", async () => {
    const response = await request(createApp({ healthChecks: passingHealthChecks })).get(
      "/api/health/ready",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ready" });
  });

  it("reports not ready without leaking dependency errors", async () => {
    const response = await request(
      createApp({
        healthChecks: {
          database: async () => Promise.reject(new Error("sensitive database error")),
          redis: async () => Promise.resolve(),
        },
      }),
    ).get("/api/health/ready");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: "not_ready" });
  });

  it("returns a generic error envelope without leaking internal errors", async () => {
    const app = createApp({ healthChecks: passingHealthChecks }, (configuredApp) => {
      configuredApp.get("/test-error", () => {
        throw new Error("sensitive internal detail");
      });
    });
    const response = await request(app).get("/test-error");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred",
      },
    });
    expect(response.text).not.toContain("sensitive internal detail");
  });
});
