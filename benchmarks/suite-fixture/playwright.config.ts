import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./pw",
  testMatch: "playwright-*.spec.ts",
  workers: 8,
  retries: 0,
  reporter: "dot",
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
