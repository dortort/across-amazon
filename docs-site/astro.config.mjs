import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { markdownPipeline } from "./src/lib/markdown-pipeline.mjs";

export default defineConfig({
  site: "https://across-amazon.dortort.dev",
  trailingSlash: "always",
  build: {
    format: "directory",
  },
  integrations: [markdownPipeline(), sitemap()],
  devToolbar: {
    enabled: false,
  },
});
