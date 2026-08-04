import { createBackendApp } from "@earendil-works/jot-backend";

const app = createBackendApp();

export default {
  fetch(request: Request): Response | Promise<Response> {
    return app.fetch(request);
  },
};
