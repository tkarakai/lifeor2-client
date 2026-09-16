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
  // Sharded CI runs emit blob reports that a downstream job merges into one HTML
  // report; a local run still gets the HTML report directly.
  //
  // Shard count lives in ci-web.yml. It is sized from a serial local run
  // (~5.3 min for ~105 tests on a fast laptop) with generous headroom, because
  // GitHub's runners are slower and each shard also pays a Convex + Next boot.
  // If observed shard times land well under `timeout-minutes`, drop the matrix
  // to 2 and halve the runner-minutes.
  reporter: process.env.CI
    ? [["github"], ["blob"]]
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
    baseURL: getEnvValue("NEXT_PUBLIC_SITE_URL", "http://localhost:3001"),
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
    command: "../../scripts/dev-start.sh --ci --app=web",
    // Playwright defaults webServer stdout to "ignore". When the script fails to
    // boot in CI that leaves "Process from config.webServer was not able to
    // start. Exit code: 1" and nothing else — no way to tell what broke.
    stdout: "pipe",
    stderr: "pipe",
    url: getEnvValue("NEXT_PUBLIC_SITE_URL", "http://localhost:3001"),
    reuseExistingServer: !process.env.CI,
    timeout: 180 * 1000,
  },
});
