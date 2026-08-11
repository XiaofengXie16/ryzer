import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "playwright.bench.spec.ts",
  fullyParallel: true,
  workers: 4,
  retries: 0,
  timeout: 10_000,
  reporter: [["json", { outputFile: "benchmark-results/playwright-latest.json" }]],
  use: {
    browserName: "chromium",
    headless: true,
    launchOptions: {
      executablePath:
        process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      args: ["--disable-extensions", "--disable-background-networking"],
    },
    viewport: { width: 1280, height: 720 },
  },
});
