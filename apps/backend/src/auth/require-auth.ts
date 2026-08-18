import type { NextFunction, Request, Response } from "express";

export function requireAuth(request: Request, response: Response, next: NextFunction): void {
  if (request.isAuthenticated() && request.user !== undefined) {
    next();
    return;
  }

  response.status(401).json({
    error: {
      code: "AUTHENTICATION_REQUIRED",
      message: "Authentication is required",
    },
  });
}
