import { defineConfig } from "@playwright/test";

const useWebServer = process.env.PW_SKIP_WEBSERVER !== "1";
const port = Number(process.env.PW_PORT ?? 4173);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  use: {
    baseURL
  },
  webServer: useWebServer
    ? {
        command: `pnpm vite --host 127.0.0.1 --port ${port} --strictPort`,
        url: `${baseURL}/popup.html`,
        reuseExistingServer: !process.env.CI
      }
    : undefined
});
