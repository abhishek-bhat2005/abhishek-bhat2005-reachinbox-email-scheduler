import { Router } from "express";

import type { AppConfig } from "../config/env.js";
import type { createPassport } from "./passport.js";
import { requireAuth } from "./require-auth.js";

type AuthRouterConfig = Pick<AppConfig, "FRONTEND_URL" | "SESSION_COOKIE_NAME">;

export function createAuthRouter(
  passport: ReturnType<typeof createPassport>,
  config: AuthRouterConfig,
): Router {
  const router = Router();
  const successRedirect = new URL("/dashboard", config.FRONTEND_URL).toString();
  const failureRedirect = new URL("/login?error=oauth_failed", config.FRONTEND_URL).toString();

  router.get(
    "/google",
    passport.authenticate("google", {
      scope: ["openid", "email", "profile"],
    }),
  );

  router.get(
    "/google/callback",
    passport.authenticate("google", { failureRedirect }),
    (_request, response) => response.redirect(successRedirect),
  );

  router.get("/me", requireAuth, (request, response) => {
    response.status(200).json({ user: request.user });
  });

  router.post("/logout", requireAuth, (request, response, next) => {
    request.logout((logoutError) => {
      if (logoutError !== undefined && logoutError !== null) {
        next(logoutError);
        return;
      }

      request.session.destroy((sessionError) => {
        if (sessionError !== undefined && sessionError !== null) {
          next(sessionError);
          return;
        }

        response.clearCookie(config.SESSION_COOKIE_NAME, { path: "/" });
        response.status(204).send();
      });
    });
  });

  return router;
}
