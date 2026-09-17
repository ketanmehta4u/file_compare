import type { Request, Response } from "express";
import { ZodError } from "zod";
import { isInputError } from "../engine/errors";
import { log } from "./middleware/requestLog";

/** An error that already knows its HTTP status -- raised by the routes
 * themselves for things like an unknown file id or a bad option. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * The single place a thrown error becomes a response.
 *
 * Every route used to answer any Error with `400` and `err.message`, which
 * meant a caller could not tell a bad upload from a bug, and internal
 * messages ended up in responses. Now:
 *
 *   HttpError  -> the status it carries, with its message
 *   ZodError   -> 400, naming the fields that failed validation (see
 *                 api/schemas.ts): the request never reached the engine
 *   InputError -> 400, with its message (safe to show: it describes the
 *                 caller's own data)
 *   anything else -> 500 and a generic message, with the real one logged
 *                 against the request id so it can still be traced
 */
export function respondWithError(req: Request, res: Response, err: unknown): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ detail: err.message });
    return;
  }

  // A body that does not match its schema. Reported field by field, because
  // "Invalid request" alone leaves the caller guessing which one.
  if (err instanceof ZodError) {
    const fields = err.issues
      .slice(0, 5)
      .map((i) => `${i.path.length > 0 ? i.path.join(".") : "body"}: ${i.message}`)
      .join("; ");
    res.status(400).json({ detail: `Invalid request — ${fields}` });
    return;
  }

  if (isInputError(err)) {
    res.status(400).json({ detail: err.message });
    return;
  }

  log.error(
    {
      ctx_request_id: req.requestId,
      ctx_path: req.originalUrl.split("?")[0],
      err: err instanceof Error ? (err.stack ?? err.message) : String(err),
    },
    "http.unhandled"
  );
  res.status(500).json({ detail: "Internal server error." });
}
