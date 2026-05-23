import type { AppConfig } from "./config.js";
import { SessionStore } from "./session-store.js";

export interface ProxyContext {
  readonly config: AppConfig;
  readonly sessions: SessionStore;
}

export function createProxyContext(config: AppConfig): ProxyContext {
  return {
    config,
    sessions: new SessionStore(),
  };
}
