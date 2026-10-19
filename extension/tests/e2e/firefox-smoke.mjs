import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { firefox } from '@playwright/test';
import { cmd } from 'web-ext';

const sourceDir = path.resolve('.output/firefox-mv2');
const artifactsDir = path.resolve('test-results/firefox-web-ext');
await mkdir(artifactsDir, { recursive: true });

let runner;
const deadline = setTimeout(() => {
  console.error('Firefox extension runtime smoke test exceeded 45 seconds.');
  process.exit(1);
}, 45_000);

try {
  runner = await cmd.run({
    artifactsDir,
    sourceDir,
    firefox: firefox.executablePath(),
    target: ['firefox-desktop'],
    startUrl: ['about:blank'],
    args: ['-headless'],
    pref: {
      'browser.shell.checkDefaultBrowser': false,
      'browser.tabs.warnOnClose': false,
    },
    noInput: true,
    noReload: true,
    keepProfileChanges: false,
    verbose: true,
  });
  const reloads = await runner.reloadAllExtensions();
  const failure = reloads.find((result) => result.reloadError);
  if (failure) throw failure.reloadError;
  console.log('Firefox loaded and remotely reloaded the Howbeam extension.');
} finally {
  try {
    // Keep the deadline armed through shutdown: web-ext exit can otherwise leave CI waiting on a wedged Firefox process.
    await runner?.exit();
  } finally {
    clearTimeout(deadline);
  }
}
