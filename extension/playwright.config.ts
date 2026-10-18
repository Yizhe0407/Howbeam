import { defineConfig } from '@playwright/test';

// Parallel runs pick their own E2E_PORT; sharing one fixed port made them attach to each other's servers.
const port = Number(process.env.E2E_PORT ?? 4175);

export default defineConfig({
  testDir: './tests/e2e/specs',
  globalSetup: './tests/e2e/setup/global-setup.ts',
  // Every test gets its own browser context and profile, so files run in parallel
  // (Playwright's default: half the CPU cores); tests within a file stay in order.
  fullyParallel: false,
  timeout: 45_000,
  expect: {
    timeout: 8_000,
  },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: 'test-results/e2e-artifacts',
  webServer: {
    command: 'node tests/e2e/fixtures/server.mjs',
    url: `http://127.0.0.1:${port}/health`,
    env: { E2E_PORT: String(port) },
    // A server left over from another run may serve stale or foreign files; opt in explicitly.
    reuseExistingServer: process.env.E2E_REUSE_SERVER === '1',
    timeout: 10_000,
  },
});
