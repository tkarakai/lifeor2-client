import { defineConfig, devices } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

/**
 * Read a value from .env.local (updated by dev-start.sh with actual ports)
 */
function getEnvValue(name: string, fallback: string): string {
  // Check app-level .env.local first, then root
  for (const envPath of [
    path.join(__dirname, ".env.local"),
    path.join(__dirname, "../../.env.local"),
  ]) {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      const match = content.match(new RegExp(`^${name}=(.*)`, "m"));
      if (match) return match[1].trim();
    }
  }
  return fallback;
}

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
    baseURL: getEnvValue("NEXT_PUBLIC_SITE_URL", "http://localhost:3002"),
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
    command: "../../scripts/dev-start.sh --ci --app=admin",
    // Playwright discards webServer stdout by default, which turns any CI
    // boot failure into a bare "Exit code: 1" with no diagnostics.
    stdout: "pipe",
    stderr: "pipe",
    url: getEnvValue("NEXT_PUBLIC_SITE_URL", "http://localhost:3002"),
    reuseExistingServer: !process.env.CI,
    timeout: 180 * 1000,
  },
});
