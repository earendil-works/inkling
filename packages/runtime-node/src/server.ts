import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { createBackendApp } from "@earendil-works/jot-backend";

export interface StartServerOptions {
  readonly port: number;
  readonly version?: string | undefined;
  readonly onListen?: (port: number) => void;
}

export function parsePort(rawValue: string | undefined): number {
  if (rawValue === undefined) {
    return 8787;
  }

  const port = Number(rawValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT value: ${rawValue}`);
  }

  return port;
}

export function startServer(options: StartServerOptions): ServerType {
  const app = createBackendApp({ version: options.version });

  return serve(
    {
      fetch: app.fetch,
      port: options.port,
    },
    (address) => options.onListen?.(address.port),
  );
}
