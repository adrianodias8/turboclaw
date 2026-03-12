import type { Store } from "../tracker/store";
import type { TurboClawConfig } from "../config";
import { createRoutes } from "./routes";
import { logger } from "../logger";

export function startGateway(store: Store, config: TurboClawConfig) {
  const handleRequest = createRoutes(store);

  const server = Bun.serve({
    port: config.gateway.port,
    hostname: config.gateway.host,
    fetch: handleRequest,
  });

  logger.info(`Gateway listening on http://${server.hostname}:${server.port}`);
  return server;
}
