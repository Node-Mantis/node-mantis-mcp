import { defineConfig } from "@playwright/test";

process.env.NODEMANTIS_TELEMETRY = "0";
export default defineConfig({
  testDir: "./tests",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: "list",
});
