import { Router } from "express";
import { currentUser } from "../middleware/currentUser";
import type { AuthMe } from "../dto";

export const authRouter = Router();

authRouter.get("/auth/me", (req, res) => {
  const body: AuthMe = { user: currentUser(req) };
  res.json(body);
});
