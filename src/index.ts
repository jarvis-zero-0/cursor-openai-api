import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./load-env.js";

// Bridge `.env` into process.env before parsing config — launchd runs
// `node dist/index.js`, which does not auto-load `.env`. process.env wins.
loadDotEnv();

const config = loadConfig();
const app = createApp(config);

serve(
  {
    fetch: app.fetch,
    port: config.PORT,
    hostname: config.HOST,
  },
  (info) => {
    console.log(
      `cursor-openai-api listening on http://${info.address}:${info.port}`,
    );
    console.log(`  cwd: ${config.CURSOR_CWD}`);
    console.log(`  default model: ${config.DEFAULT_MODEL}`);
  },
);
