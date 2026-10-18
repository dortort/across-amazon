import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const SOURCEMAP_COMMENT = /\n?\/\/# sourceMappingURL=[^\n]*\n?$/;

function shiftMappingsOneLine(json: string): string {
  const map = JSON.parse(json) as { mappings: string };
  return JSON.stringify({ ...map, mappings: `;${map.mappings}` });
}

function isolateContentScripts(): Plugin {
  return {
    name: "across-amazon:isolate-content-scripts",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk" || !chunk.fileName.startsWith("content/")) {
          continue;
        }

        if (chunk.imports.length > 0 || chunk.dynamicImports.length > 0 || chunk.exports.length > 0) {
          this.error(
            `${chunk.fileName} must not import or export anything: chrome.scripting injects it as a classic script`
          );
        }

        const comment = chunk.code.match(SOURCEMAP_COMMENT)?.[0] ?? "";
        const body = chunk.code.slice(0, chunk.code.length - comment.length);
        chunk.code = `(() => {\n${body}\n})();${comment}`;

        if (chunk.map) {
          chunk.map.mappings = `;${chunk.map.mappings}`;
        }

        const mapAsset = chunk.sourcemapFileName ? bundle[chunk.sourcemapFileName] : undefined;
        if (mapAsset?.type === "asset" && typeof mapAsset.source === "string") {
          mapAsset.source = shiftMappingsOneLine(mapAsset.source);
        }
      }
    }
  };
}

export default defineConfig({
  plugins: [react(), isolateContentScripts()],
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
        "content/product-extractor": resolve(__dirname, "src/content/product-extractor.ts"),
        "content/location-setter": resolve(__dirname, "src/content/location-setter.ts")
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
