import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import { requireAuth } from "../../src/auth/require-auth.js";

describe("authentication middleware", () => {
  it("rejects anonymous requests", () => {
    const request = {
      isAuthenticated: () => false,
    } as Request;
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const response = { status } as unknown as Response;
    const next = vi.fn() as NextFunction;

    requireAuth(request, response, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({
      error: {
        code: "AUTHENTICATION_REQUIRED",
        message: "Authentication is required",
      },
    });
    expect(next).not.toHaveBeenCalled();
  });
});
