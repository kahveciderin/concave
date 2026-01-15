import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { ResourceError, formatErrorResponse } from "@/resource/error";

export const errorMiddleware = (
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  console.error(`[ERROR] ${req.method} ${req.path}:`, error);

  let statusCode = 500;
  if (error instanceof ResourceError) {
    statusCode = error.statusCode;
  } else if (error instanceof ZodError) {
    statusCode = 400;
  }

  const response = formatErrorResponse(error);
  res.status(statusCode).json(response);
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
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `Route ${req.method} ${req.path} not found`,
    },
  });
};
