import path from "node:path";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  base: "/",
  plugins: [preact()],
  build: {
    outDir: path.join(import.meta.dirname, "dist"),
    emptyOutDir: true,
    assetsDir: "assets",
    target: "es2022",
    sourcemap: false,
    // The shell CSP only allows same-origin fonts and scripts, so nothing may be inlined as a data: URI.
    assetsInlineLimit: 0,
  },
});
