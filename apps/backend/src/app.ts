import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";

export interface HealthChecks {
  database: () => Promise<unknown>;
  redis: () => Promise<unknown>;
}

export interface AppDependencies {
  healthChecks: HealthChecks;
}

export type ConfigureApp = (app: Express) => void;

export function createApp(dependencies: AppDependencies, configure?: ConfigureApp): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json());
  configure?.(app);
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

  const errorHandler: ErrorRequestHandler = (
    _error: unknown,
    _request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    void next;
    response.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred",
      },
    });
  };

  app.use(errorHandler);

  return app;
}
