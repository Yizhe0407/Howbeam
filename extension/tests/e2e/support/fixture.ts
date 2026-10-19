import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, test as base, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { RECORDING_STATE_KEY } from './harness';
import { preparedExtensionPath } from './paths';

export const FIXTURE_PORT = Number(process.env.E2E_PORT ?? 4175);
export const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}/`;

const isWelcomePage = (page: Page) => page.url().endsWith('/welcome.html');

declare const chrome: {
  storage: {
    onChanged: {
      addListener(listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void): void;
    };
  };
  tabs: {
    onActivated: {
      addListener(listener: (info: { tabId: number; windowId: number }) => void): void;
    };
  };
};

/**
 * Inside the service worker: logs every recording-state write and tab
 * activation, so a failed spec's console log shows how the run moved.
 */
function traceRecordingInWorker(recordingStateKey: string): void {
  const scope = globalThis as typeof globalThis & { __howbeamE2eTrace?: true };
  if (scope.__howbeamE2eTrace) return;
  scope.__howbeamE2eTrace = true;
  chrome.storage.onChanged.addListener((changes, area) => {
    const change = changes[recordingStateKey];
    if (area !== 'local' || !change) return;
    const state = (change.newValue ?? {}) as Record<string, unknown>;
    const notice = state.recoverableError as { code?: string } | null | undefined;
    console.debug('[e2e] state', JSON.stringify({
      runId: state.runId,
      mode: state.mode,
      phase: state.phase,
      tabId: state.tabId,
      itemCount: state.itemCount,
      notice: notice?.code ?? null,
    }));
  });
  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
    console.debug('[e2e] tab activated', JSON.stringify({ tabId, windowId }));
  });
}

/**
 * Every console message from the context's pages and service worker, once
 * each and in arrival order, attached to a failed spec next to its trace.
 */
function collectExtensionLog(context: BrowserContext): string[] {
  const lines: string[] = [];
  const startedAt = Date.now();
  const record = (source: string, type: string, text: string) => {
    lines.push(`+${String(Date.now() - startedAt).padStart(6)}ms ${source} ${type}: ${text}`);
  };
  context.on('console', (message) => {
    const source = message.worker() ? 'worker' : `page ${message.page()?.url() ?? '?'}`;
    record(source, message.type(), message.text());
  });
  context.on('weberror', (error) => record(`page ${error.page()?.url() ?? '?'}`, 'pageerror', String(error.error())));
  const traceWorker = (worker: Worker) => {
    void worker.evaluate(traceRecordingInWorker, RECORDING_STATE_KEY).catch((error) => {
      record('worker', 'trace', `could not install the recording trace: ${error}`);
    });
  };
  for (const worker of context.serviceWorkers()) traceWorker(worker);
  // A respawned worker starts without the trace; install it again.
  context.on('serviceworker', traceWorker);
  return lines;
}

/**
 * A fresh profile is a first install, so the extension opens its welcome page
 * on its own. Waiting for it proves the first-run behaviour on every run, and
 * closing it gives every spec the same single starting tab.
 */
async function dismissWelcomePage(context: BrowserContext): Promise<void> {
  await expect.poll(() => context.pages().some(isWelcomePage), {
    message: 'the extension should open welcome.html on install',
    timeout: 15_000,
  }).toBe(true);
  for (const page of context.pages().filter(isWelcomePage)) await page.close();
}

type Fixtures = {
  extensionContext: BrowserContext;
  extensionId: string;
  appPage: Page;
  popupPage: Page;
  browserErrors: string[];
};

type Options = {
  /** Opt a spec into scrollbars that paint and take layout space, via `test.use({ nativeScrollbars: true })`; off by default so the rest of the suite keeps Chromium headless's scrollbar-free geometry. */
  nativeScrollbars: boolean;
  /** Disable trace collection for latency-sensitive benchmark runs. */
  recordTrace: boolean;
};

export const test = base.extend<Fixtures & Options>({
  nativeScrollbars: [false, { option: true }],
  recordTrace: [true, { option: true }],

  extensionContext: async ({ nativeScrollbars, recordTrace }, use, testInfo) => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'howbeam-playwright-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: process.env.PW_HEADED !== '1',
      // Chromium 的 --hide-scrollbars 是此 fixture 捲軸間隙的唯一開關；僅像素斷言需移除它。
      ignoreDefaultArgs: nativeScrollbars ? ['--hide-scrollbars'] : undefined,
      viewport: null,
      acceptDownloads: true,
      // The specs read the zh-TW interface, and the extension follows the
      // browser's UI language (chrome.i18n.getUILanguage). On Linux that comes
      // from the environment, not --lang; `locale` alone only emulates it in
      // pages Playwright opens, so tabs the extension opens itself would still
      // come up in the host's language.
      env: { ...process.env, LANGUAGE: 'zh_TW', LANG: 'zh_TW.UTF-8' },
      locale: 'zh-TW',
      args: [
        `--disable-extensions-except=${preparedExtensionPath}`,
        `--load-extension=${preparedExtensionPath}`,
        '--window-size=1280,900',
        '--force-device-scale-factor=1',
        // ignoreDefaultArgs 處理 headless；此參數只補強 headed 模式。
        ...(nativeScrollbars || process.env.PW_HEADED === '1' ? ['--show-scrollbars'] : []),
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    const extensionLog = collectExtensionLog(context);
    await dismissWelcomePage(context);
    await mkdir(testInfo.outputPath('browser'), { recursive: true });
    if (recordTrace) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    }
    try {
      await use(context);
      if (testInfo.status !== testInfo.expectedStatus) {
        const extensionLogPath = testInfo.outputPath('browser/extension-log.txt');
        await writeFile(extensionLogPath, `${extensionLog.join('\n')}\n`);
        await testInfo.attach('extension-log', { path: extensionLogPath, contentType: 'text/plain' });
        for (const [index, page] of context.pages().entries()) {
          await page.screenshot({ path: testInfo.outputPath(`browser/page-${index}.png`), fullPage: true }).catch(() => {});
        }
        if (recordTrace) {
          await context.tracing.stop({ path: testInfo.outputPath('browser/trace.zip') }).catch(() => {});
        }
      } else if (recordTrace) {
        await context.tracing.stop().catch(() => {});
      }
    } finally {
      await context.close().catch(() => {});
      await rm(userDataDir, { recursive: true, force: true });
    }
  },

  extensionId: async ({ extensionContext }, use) => {
    let worker = extensionContext.serviceWorkers()[0];
    if (!worker) worker = await extensionContext.waitForEvent('serviceworker');
    await use(new URL(worker.url()).host);
  },

  appPage: async ({ extensionContext }, use) => {
    const page = extensionContext.pages()[0] ?? await extensionContext.newPage();
    await page.goto(FIXTURE_URL);
    await use(page);
  },

  popupPage: async ({ extensionContext, extensionId }, use) => {
    const popup = await extensionContext.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await use(popup);
  },

  browserErrors: async ({ extensionContext }, use, testInfo) => {
    const errors: string[] = [];
    const attachPage = (page: Page) => {
      page.on('pageerror', (error) => errors.push(`pageerror: ${error}`));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`console: ${message.text()}`);
      });
    };
    for (const page of extensionContext.pages()) attachPage(page);
    extensionContext.on('page', attachPage);
    const attachWorker = (worker: Worker) => {
      worker.on('console', (message) => {
        if (message.type() === 'error') errors.push(`worker: ${message.text()}`);
      });
    };
    for (const worker of extensionContext.serviceWorkers()) attachWorker(worker);
    // MV3 service workers restart at will; hook replacements too so errors from a respawned background aren't dropped.
    extensionContext.on('serviceworker', attachWorker);
    await use(errors);
    if (errors.length > 0) {
      await testInfo.attach('browser-errors.json', {
        body: JSON.stringify(errors, null, 2),
        contentType: 'application/json',
      });
    }
    expect(errors, 'browser console errors').toEqual([]);
  },
});

export { expect };
