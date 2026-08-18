import express, { type Express } from "express";

export interface HealthChecks {
  database: () => Promise<unknown>;
  redis: () => Promise<unknown>;
}

export interface AppDependencies {
  healthChecks: HealthChecks;
}

export function createApp(dependencies: AppDependencies): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json());
  app.get("/api/health/live", (_request, response) => {
    response.status(200).json({ status: "alive" });
  });

  app.get("/api/health/ready", async (_request, response) => {
    try {
      await Promise.all([dependencies.healthChecks.database(), dependencies.healthChecks.redis()]);
      response.status(200).json({ status: "ready" });
    } catch {
      response.status(503).json({ status: "not_ready" });
    }
  });

  return app;
}
