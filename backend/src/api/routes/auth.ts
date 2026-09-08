import { Router } from "express";
import { currentUser } from "../middleware/currentUser";
import type { AuthMe } from "../dto";

export const authRouter = Router();

/**
 * Who the caller is, as far as this service can tell.
 *
 * There is no login here: currentUser() reads whichever identity header a
 * fronting reverse proxy has already verified, and returns "" when none is
 * present (local development, or a deployment with no proxy). The UI shows
 * the result in its status bar, and the value is stamped into every audit
 * report so a reconciliation can be attributed.
 */

authRouter.get("/auth/me", (req, res) => {
  const body: AuthMe = { user: currentUser(req) };
  res.json(body);
});
