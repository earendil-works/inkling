import { Effect } from "effect";

import { parsePort, resolveDataDirectory, startServer } from "./server.ts";

const port = parsePort(process.env["PORT"]);
const dataDirectory = resolveDataDirectory(process.env["INKLING_DATA_DIR"]);

const program = Effect.scoped(
  startServer({
    dataDirectory,
    onListen: (listeningPort) => {
      console.log(`Inkling listening at http://localhost:${listeningPort}`);
      console.log(`Data directory: ${dataDirectory}`);
    },
    port,
    theme: process.env["INKLING_THEME"],
    version: process.env["INKLING_VERSION"],
  }).pipe(Effect.zipRight(Effect.never)),
);

Effect.runPromise(program).catch((error: unknown) => {
  console.error("Inkling failed to start", error);
  process.exitCode = 1;
});
