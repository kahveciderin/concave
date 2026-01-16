import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import {
  ResourceError,
  formatRFC7807Error,
  RateLimitError,
  ERROR_TYPES,
  ProblemDetail,
} from "@/resource/error";

export interface RequestWithId extends Request {
  requestId?: string;
}

export const errorMiddleware = (
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const requestId = (req as RequestWithId).requestId;

  console.error(
    JSON.stringify({
      level: "error",
      requestId,
      method: req.method,
      path: req.path,
      error: error instanceof Error ? error.message : String(error),
      stack: process.env.CONCAVE_DEBUG === "1" && error instanceof Error ? error.stack : undefined,
    })
  );

  let statusCode = 500;
  if (error instanceof ResourceError) {
    statusCode = error.statusCode;
  } else if (error instanceof ZodError) {
    statusCode = 400;
  }

  const problem = formatRFC7807Error(error, requestId);

  if (error instanceof RateLimitError) {
    res.set("Retry-After", String(Math.ceil(error.retryAfter / 1000)));
  }

  res
    .status(statusCode)
    .set("Content-Type", "application/problem+json")
    .json(problem);
};

export const asyncHandler = <T>(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<T>
) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

export const notFoundHandler = (
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const requestId = (req as RequestWithId).requestId;

  const problem: ProblemDetail = {
    type: ERROR_TYPES.NOT_FOUND,
    title: "Not found",
    status: 404,
    detail: `Route ${req.method} ${req.path} not found`,
    code: "NOT_FOUND",
  };

  if (requestId) {
    problem.instance = `/requests/${requestId}`;
    problem.requestId = requestId;
  }

  res.status(404).set("Content-Type", "application/problem+json").json(problem);
};
