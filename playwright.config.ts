import { defineConfig } from "@playwright/test";

const useWebServer = process.env.PW_SKIP_WEBSERVER !== "1";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:4173"
  },
  webServer: useWebServer
    ? {
        command: "pnpm vite --host 127.0.0.1 --port 4173",
        url: "http://127.0.0.1:4173/popup.html",
        reuseExistingServer: !process.env.CI
      }
    : undefined
});
