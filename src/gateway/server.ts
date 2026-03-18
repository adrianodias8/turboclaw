import type { Store } from "../tracker/store";
import type { TurboClawConfig } from "../config";
import { createRoutes } from "./routes";
import { logger } from "../logger";

export interface GatewayOptions {
  restartToken?: string;
  requestRestart?: () => void;
  vaultPath?: string;
  skillsDir?: string;
  checkpointsBase?: string;
  workspaceRoot?: string;
  home?: string;
}

export function startGateway(store: Store, config: TurboClawConfig, opts?: GatewayOptions) {
  const handleRequest = createRoutes(store, opts);

  const server = Bun.serve({
    port: config.gateway.port,
    hostname: config.gateway.host,
    async fetch(req: Request) {
      const start = Date.now();
      const url = new URL(req.url);
      const response = await handleRequest(req);
      const durationMs = Date.now() - start;
      const level = response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "debug";
      logger[level](`${req.method} ${url.pathname} → ${response.status} (${durationMs}ms)`);
      return response;
    },
  });

  logger.info(`Gateway listening on http://${server.hostname}:${server.port}`);
  return server;
}
