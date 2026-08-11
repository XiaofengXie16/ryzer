import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: /playwright-[ab]\.spec\.ts/,
  fullyParallel: true,
  reporter: [["json", { outputFile: process.env.INCREMENTAL_PW_OUTPUT }]],
  use: {
    channel: "chrome",
    headless: true,
    viewport: { width: 1280, height: 720 },
  },
});
