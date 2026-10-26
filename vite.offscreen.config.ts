import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        "offscreen/offscreen": resolve(__dirname, "src/offscreen/offscreen.ts")
      },
      output: {
        entryFileNames: "[name].js",
        format: "es",
        inlineDynamicImports: true
      }
    }
  }
});
