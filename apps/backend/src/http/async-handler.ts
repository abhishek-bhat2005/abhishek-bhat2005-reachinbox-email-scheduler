import type { NextFunction, Request, RequestHandler, Response } from "express";

type AsyncRoute = (request: Request, response: Response, next: NextFunction) => Promise<void>;

export function asyncHandler(handler: AsyncRoute): RequestHandler {
  return (request, response, next) => {
    void handler(request, response, next).catch(next);
  };
}
