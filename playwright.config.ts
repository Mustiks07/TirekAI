import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    launchOptions:
      process.platform === "win32"
        ? {
            executablePath:
              "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          }
        : // Optional local override when the preinstalled browser build differs from the pinned Playwright.
          process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
          : {},
  },
  webServer: {
    command: "npm run preview",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      PORT: "3100",
      PGLITE_DATA_DIR: `.data/e2e-${Date.now()}`,
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
