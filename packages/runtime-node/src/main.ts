import { parsePort, startServer } from "./server.ts";

const port = parsePort(process.env["PORT"]);

startServer({
  onListen: (listeningPort) => {
    console.log(`Jot API listening at http://localhost:${listeningPort}`);
  },
  port,
  version: process.env["JOT_VERSION"],
});
