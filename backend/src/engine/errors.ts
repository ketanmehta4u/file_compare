/**
 * An error caused by the data or options the caller supplied: an empty
 * file, a legacy .xls, a missing sheet, a malformed catalogue.
 *
 * The distinction matters at the HTTP boundary. Every route used to answer
 * any thrown Error with 400 and its message, which made a bad upload and
 * an internal fault indistinguishable to a caller -- and put internal
 * messages in responses. Anything thrown as an InputError is safe to show
 * the user and is their fault to fix; anything else is ours, and becomes a
 * 500 with a generic message and a log line.
 */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

/** True for an InputError, including one rebuilt after crossing a worker
 * boundary (where the class itself does not survive). */
export function isInputError(err: unknown): err is InputError {
  return err instanceof Error && err.name === "InputError";
}
