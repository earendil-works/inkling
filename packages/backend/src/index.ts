import { Hono } from "hono";

import { protocolVersion } from "@earendil-works/jot-protocol";
import type { HealthResponse, ProtocolError } from "@earendil-works/jot-protocol";

export interface BackendOptions {
  readonly version?: string | undefined;
}

export function createBackendApp(options: BackendOptions = {}): Hono {
  const app = new Hono();
  const version = options.version ?? "development";

  app.get("/api/health", (context) => {
    const response: HealthResponse = {
      protocolVersion,
      service: "jot",
      status: "ok",
      version,
    };

    context.header("Cache-Control", "no-store");
    return context.json(response);
  });

  app.notFound((context) => {
    const response: ProtocolError = {
      code: "not_found",
      message: "The requested Jot resource does not exist.",
      retryable: false,
    };

    return context.json(response, 404);
  });

  return app;
}
