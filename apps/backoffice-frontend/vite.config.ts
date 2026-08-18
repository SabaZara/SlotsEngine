import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * `PORT` wins when it is set, otherwise 9106.
 *
 * 9106 is what the compose stack publishes for the BUILT frontend, so a
 * dev server hardcoded to it either fails to bind or shadows the container
 * — and a harness that assigns a free port had no way to tell Vite about
 * it. Reading the env var makes the assigned port authoritative while
 * keeping 9106 as the plain `npm run dev` default.
 */
const port = Number(process.env.PORT) || 9106;

export default defineConfig({
  plugins: [react()],
  server: { port, host: true },
  preview: { port, host: true },
  build: { outDir: "dist", sourcemap: true },
});
