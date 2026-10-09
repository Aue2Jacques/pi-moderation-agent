// Build: `pnpm --filter @mod/console build` -> dist/, served by G at /. Dev: `pnpm --filter @mod/console dev` with G on
// 127.0.0.1:8080 (the API is proxied). No React plugin: esbuild compiles TSX with the automatic runtime.
import { defineConfig } from "vite";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 800 },
  server: { proxy: { "/api": { target: `http://127.0.0.1:${process.env["G_PORT"] ?? 8080}`, changeOrigin: false } } },
});
