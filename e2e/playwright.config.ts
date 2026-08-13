import { defineConfig, devices } from '@playwright/test';

const daemonPort = Number(process.env.OD_PORT) || 17_456;
const webPort = Number(process.env.OD_WEB_PORT) || 17_573;
const baseURL = `http://127.0.0.1:${webPort}`;
const namespace = process.env.OD_E2E_NAMESPACE || `playwright-${process.pid}`;
const dataDir = process.env.OD_E2E_DATA_DIR || `e2e/ui/.od-data/${namespace}`;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export default defineConfig({
  testDir: './ui',
  outputDir: './ui/reports/test-results',
  timeout: Number(process.env.OD_PLAYWRIGHT_TIMEOUT) || 30_000,
  retries: process.env.CI ? 1 : 0,
  expect: {
    timeout: 10_000,
  },
  // The webServer owns one daemon and one OD_DATA_DIR for the entire UI suite.
  // Keep backend-mutating UI tests serialized until the harness can boot an
  // isolated daemon/data directory per worker.
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI
    ? [
        ['github'],
        ['list'],
        ['html', { open: 'never', outputFolder: './ui/reports/playwright-html-report' }],
        ['json', { outputFile: './ui/reports/results.json' }],
        ['junit', { outputFile: './ui/reports/junit.xml' }],
      ]
    : [
        ['list'],
        ['html', { open: 'never', outputFolder: './ui/reports/playwright-html-report' }],
        ['json', { outputFile: './ui/reports/results.json' }],
        ['junit', { outputFile: './ui/reports/junit.xml' }],
      ],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command:
      `OD_DATA_DIR=${shellQuote(dataDir)} ` +
      `pnpm --dir .. tools-dev run web --namespace ${shellQuote(namespace)} --daemon-port ${daemonPort} --web-port ${webPort}`,
    // The whole e2e/ui suite assumes Google SSO is OFF (load-local-env.ts
    // only fills vars that are still undefined, so setting these to '' here
    // always wins over whatever a dev-local `.env.local` happens to carry —
    // e.g. after `make dev` renders real GOOGLE_CLIENT_ID/SECRET into it).
    env: { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
