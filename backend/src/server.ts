/**
 * Process entry point: build the Express app and listen.
 *
 * Deliberately thin, and separate from app.ts, so the whole application
 * can be constructed in-process without binding a port -- which is what
 * the API test suite does (supertest drives createApp() directly).
 */
import { createApp } from "./app";
import { port } from "./config/env";

const app = createApp();
const p = port();

app.listen(p, () => {
  console.log(`backend listening on :${p}`);
});
