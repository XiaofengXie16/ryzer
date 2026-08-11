import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "playwright.overhead.spec.ts",
  workers: 1,
  retries: 0,
  reporter: "json",
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
