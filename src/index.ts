import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./load-env.js";

// Bridge `.env` into process.env before parsing config — launchd runs
// `node dist/index.js`, which does not auto-load `.env`. process.env wins.
loadDotEnv();

installProcessGuards();

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

/**
 * Keep the proxy alive through stray background errors from the Cursor SDK's
 * HTTP/2 transport (connect-node). The SDK surfaces upstream stream failures —
 * backend throttling (`NGHTTP2_ENHANCE_YOUR_CALM`), transient auth blips during
 * credential rotation (`ERROR_NOT_LOGGED_IN`), and aborted/cancelled runs
 * (`ECANCELED`) — as rejections that are NOT attached to the awaited per-request
 * promise (they fire on the underlying HTTP/2 stream, sometimes on a shared
 * client outside any request). Node's default is to treat an unhandled
 * rejection / uncaught exception as fatal, which kills the whole process and
 * tears down EVERY in-flight SSE response — clients then see
 * "peer closed connection without sending complete message body
 * (incomplete chunked read)" — and launchd restarts us, wiping all in-memory
 * sessions. The per-request path already converts its own awaited errors into
 * graceful OpenAI error responses, so downgrade these stray background errors
 * to logged-and-survive: one bad upstream stream must not take down unrelated
 * concurrent turns.
 */
function installProcessGuards(): void {
  const log = (kind: string, err: unknown) => {
    const e = err as { message?: string; code?: unknown } | undefined;
    const detail = e?.message ?? (typeof err === "string" ? err : String(err));
    const code = e?.code !== undefined ? ` code=${String(e.code)}` : "";
    console.error(
      `[cursor-openai-api] ${kind} (logged, not crashing):${code} ${detail}`,
    );
  };
  process.on("unhandledRejection", (reason) =>
    log("unhandledRejection", reason),
  );
  process.on("uncaughtException", (err) => log("uncaughtException", err));
}
