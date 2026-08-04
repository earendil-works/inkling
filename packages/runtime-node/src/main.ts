import { Effect } from "effect";

import { parsePort, resolveDataDirectory, startServer } from "./server.ts";

const port = parsePort(process.env["PORT"]);
const dataDirectory = resolveDataDirectory(process.env["JOT_DATA_DIR"]);

const program = Effect.scoped(
  startServer({
    dataDirectory,
    onListen: (listeningPort) => {
      console.log(`Jot listening at http://localhost:${listeningPort}`);
      console.log(`Data directory: ${dataDirectory}`);
    },
    port,
    version: process.env["JOT_VERSION"],
  }).pipe(Effect.zipRight(Effect.never)),
);

Effect.runPromise(program).catch((error: unknown) => {
  console.error("Jot failed to start", error);
  process.exitCode = 1;
});
