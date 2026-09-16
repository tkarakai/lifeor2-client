import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./qa/e2e",
  outputDir: "./qa/test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["github"], ["html", { outputFolder: "qa/playwright-report" }]]
    : [["html", { outputFolder: "qa/playwright-report" }]],
  updateSnapshots: "missing",
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{testFilePath}/{arg}{ext}",
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
      threshold: 0.2,
    },
  },
  use: {
    baseURL: "http://localhost:3004",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // `npx serve` downloads the package on a cold runner, which blew the old
    // 30s timeout. serve is now a devDependency, so use the local binary.
    command: "./node_modules/.bin/serve out -l 3004",
    // Playwright discards webServer stdout by default, which turns any CI
    // boot failure into a bare "Exit code: 1" with no diagnostics.
    stdout: "pipe",
    stderr: "pipe",
    url: "http://localhost:3004",
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
