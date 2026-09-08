import { createApp } from "./app";
import { port } from "./config/env";

const app = createApp();
const p = port();

app.listen(p, () => {
  console.log(`backend listening on :${p}`);
});
