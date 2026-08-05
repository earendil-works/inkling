import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2023",
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        changeOrigin: false,
        target: "http://localhost:8787",
        ws: true,
      },
    },
  },
});
