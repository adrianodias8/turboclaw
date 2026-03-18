import type { Store } from "../tracker/store";
import type { TurboClawConfig } from "../config";
import { createRoutes } from "./routes";
import { createRateLimiter } from "./rate-limit";
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
  const rateLimiter = createRateLimiter();
  const cleanupInterval = setInterval(() => rateLimiter.cleanup(), 60000);

  const server = Bun.serve({
    port: config.gateway.port,
    hostname: config.gateway.host,
    async fetch(req: Request) {
      const start = Date.now();
      const url = new URL(req.url);

      // Rate limiting (exempt /health for Docker healthchecks)
      if (url.pathname !== "/health") {
        const ip = server.requestIP(req)?.address ?? "unknown";
        if (!rateLimiter.check(ip)) {
          return new Response(JSON.stringify({ error: "Too many requests" }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      try {
        const response = await handleRequest(req);
        const durationMs = Date.now() - start;
        const level = response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "debug";
        logger[level](`${req.method} ${url.pathname} → ${response.status} (${durationMs}ms)`);
        return response;
      } catch (err) {
        logger.error(`${req.method} ${url.pathname} — unhandled error:`, err);
        return new Response(JSON.stringify({ error: "Internal server error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    },
  });

  logger.info(`Gateway listening on http://${server.hostname}:${server.port}`);
  return server;
}
