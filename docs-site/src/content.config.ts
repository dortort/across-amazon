import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

const privacy = defineCollection({
  loader: glob({ base: "../docs", pattern: "privacy-policy.md" }),
});

export const collections = { privacy };
