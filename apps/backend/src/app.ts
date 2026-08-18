import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import multer from "multer";

import { HttpError } from "./http/http-error.js";

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

  configure?.(app);

  const errorHandler: ErrorRequestHandler = (
    error: unknown,
    _request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    void next;

    if (error instanceof HttpError) {
      response.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
      return;
    }

    if (error instanceof multer.MulterError) {
      const fileTooLarge = error.code === "LIMIT_FILE_SIZE";
      response.status(fileTooLarge ? 413 : 400).json({
        error: {
          code: fileTooLarge ? "UPLOAD_TOO_LARGE" : "INVALID_UPLOAD",
          message: fileTooLarge
            ? "The uploaded file exceeds the configured size limit"
            : "The multipart upload is invalid",
        },
      });
      return;
    }

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
