import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 9104, host: true },
  preview: { port: 9104, host: true },
  build: { outDir: "dist", sourcemap: true },
});
