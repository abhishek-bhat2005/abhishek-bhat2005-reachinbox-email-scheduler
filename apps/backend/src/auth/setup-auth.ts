import cors from "cors";
import type { Express } from "express";
import session from "express-session";
import helmet from "helmet";

import type { AppConfig } from "../config/env.js";
import type { DatabaseClient } from "../db/prisma.js";
import type { RedisClient } from "../redis/client.js";
import { createPassport } from "./passport.js";
import { RedisSessionStore } from "./redis-session-store.js";
import { createAuthRouter } from "./router.js";

export interface AuthDependencies {
  config: AppConfig;
  database: DatabaseClient;
  redis: RedisClient;
}

export function setupAuth(app: Express, dependencies: AuthDependencies): void {
  const { config, database, redis } = dependencies;
  const passport = createPassport(database, config);
  const sessionStore = new RedisSessionStore(
    redis,
    config.SESSION_REDIS_PREFIX,
    config.SESSION_TTL_MS,
  );

  if (config.TRUST_PROXY) {
    app.set("trust proxy", true);
  }

  app.use(helmet());
  app.use(
    cors({
      origin: config.FRONTEND_URL,
      credentials: true,
    }),
  );
  app.use(
    session({
      cookie: {
        httpOnly: true,
        maxAge: config.SESSION_TTL_MS,
        sameSite: config.NODE_ENV === "production" ? "none" : "lax",
        secure: config.NODE_ENV === "production",
      },
      name: config.SESSION_COOKIE_NAME,
      resave: false,
      rolling: true,
      saveUninitialized: false,
      secret: config.SESSION_SECRET,
      store: sessionStore,
    }),
  );
  app.use(passport.initialize());
  app.use(passport.session());
  app.use("/api/auth", createAuthRouter(passport, config));
}
