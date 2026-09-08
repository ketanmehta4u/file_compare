import express, { type Express } from "express";

export function createApp(): Express {
  const app = express();

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/livez", (_req, res) => {
    res.json({ status: "alive" });
  });

  return app;
}
