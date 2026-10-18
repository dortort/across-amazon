import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "popup.html"),
        options: resolve(__dirname, "options.html"),
        "background/service-worker": resolve(__dirname, "src/background/service-worker.ts"),
        "content/source-extractor": resolve(__dirname, "src/content/source-extractor.ts"),
        "content/search-extractor": resolve(__dirname, "src/content/search-extractor.ts"),
        "content/product-extractor": resolve(__dirname, "src/content/product-extractor.ts")
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "assets/[name][extname]"
      }
    }
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["tests/unit/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/unit/setup.ts"]
  }
});
