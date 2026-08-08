import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2023",
  },
  server: {
    port: 5173,
    proxy: {
      "/AGENTS.md": {
        changeOrigin: false,
        target: "http://localhost:8787",
      },
      "/api": {
        changeOrigin: false,
        target: "http://localhost:8787",
        ws: true,
      },
    },
  },
});
