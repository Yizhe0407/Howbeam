import { test, expect } from '../support/fixture';
import {
  clickTarget,
  rawScreenshotRosePixels,
  readRecordingState,
  readRootScrollbarSentinelPixels,
  readScreenshotScrollbarStats,
  readSteps,
  resetExtensionData,
  startRecording,
  stopRecording,
} from '../support/harness';
import { itemAt } from '../../setup/item-at';

interface Geometry {
  innerWidth: number;
  clientWidth: number;
  targetLeft: number;
  targetWidth: number;
}

interface CaptureMonitor {
  baseline: Geometry;
  hidden: Geometry | null;
  restored: Geometry | null;
}

async function installCaptureMonitor(page: Parameters<typeof startRecording>[0], failCapture = false): Promise<void> {
  await page.evaluate((shouldFail) => {
    const geometry = (): Geometry => {
      const target = document.querySelector('#plain-card')!.getBoundingClientRect();
      return {
        innerWidth: window.innerWidth,
        clientWidth: document.documentElement.clientWidth,
        targetLeft: target.left,
        targetWidth: target.width,
      };
    };
    const monitor: CaptureMonitor = { baseline: geometry(), hidden: null, restored: null };
    window.capturePresentationMonitor = monitor;
    const originalUrl = location.href;

    const sample = () => {
      const thumb = getComputedStyle(document.documentElement, '::-webkit-scrollbar-thumb');
      const hidden = thumb.backgroundColor === 'rgba(0, 0, 0, 0)';
      if (hidden && !monitor.hidden) {
        monitor.hidden = geometry();
        if (shouldFail) history.replaceState({}, '', `${location.pathname}?capture-must-fail=1`);
      } else if (!hidden && monitor.hidden) {
        monitor.restored = geometry();
        if (!shouldFail || location.href !== originalUrl) return;
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, failCapture);
}

async function expectRealRootScrollbar(page: Parameters<typeof startRecording>[0]): Promise<Geometry> {
  const state = await page.evaluate(() => {
    const thumb = getComputedStyle(document.documentElement, '::-webkit-scrollbar-thumb');
    const geometry: Geometry = {
      innerWidth: window.innerWidth,
      clientWidth: document.documentElement.clientWidth,
      targetLeft: document.querySelector('#plain-card')!.getBoundingClientRect().left,
      targetWidth: document.querySelector('#plain-card')!.getBoundingClientRect().width,
    };
    return { color: thumb.backgroundColor, geometry };
  });
  expect(state.color).toBe('rgb(255, 0, 255)');
  // Fixture 的自訂捲軸在所有平台佔佈局空間；零間隙代表真實回歸，不可 skip。
  expect(
    state.geometry.innerWidth - state.geometry.clientWidth,
    'root scrollbar gutter (is --hide-scrollbars still stripped in fixture.ts?)',
  ).toBeGreaterThan(0);
  return state.geometry;
}

async function expectPresentationRestored(page: Parameters<typeof startRecording>[0], baseline: Geometry): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.capturePresentationMonitor)).toMatchObject({
    baseline,
    hidden: baseline,
    restored: baseline,
  });
  await expect.poll(() => page.evaluate(() => (
    getComputedStyle(document.documentElement, '::-webkit-scrollbar-thumb').backgroundColor
  ))).toBe('rgb(255, 0, 255)');
}

async function paintInteractionHostRose(
  page: Parameters<typeof startRecording>[0],
  attribute: 'data-howbeam-snapshot-shield' | 'data-howbeam-step-preview',
): Promise<void> {
  await page.evaluate((hostAttribute) => {
    window.captureHostPainted = false;
    const paint = () => {
      const host = document.querySelector<HTMLElement>(`[${hostAttribute}]`);
      if (!host) return false;
      host.style.setProperty('background-color', '#f43f5e', 'important');
      window.captureHostPainted = true;
      return true;
    };
    if (paint()) return;
    const observer = new MutationObserver(() => {
      if (!paint()) return;
      observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }, attribute);
}

async function neutralProbeBounds(page: Parameters<typeof startRecording>[0]) {
  return page.locator('#plain-text').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
}

test.describe('screenshot presentation', () => {
  // Every assertion here is about scrollbar pixels, so only this suite runs the browser with scrollbars that occupy layout space.
  test.use({ nativeScrollbars: true });

  test.beforeEach(async ({ popupPage }) => {
    await resetExtensionData(popupPage);
  });

  test('step screenshots omit the root scrollbar without moving page geometry', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    const baseline = await expectRealRootScrollbar(appPage);
    expect(await readRootScrollbarSentinelPixels(appPage)).toBeGreaterThan(0);
    await installCaptureMonitor(appPage);
    await startRecording(appPage, popupPage, 'steps');
    await paintInteractionHostRose(appPage, 'data-howbeam-step-preview');
    await expect.poll(() => appPage.evaluate(() => window.captureHostPainted)).toBe(true);
    await clickTarget(appPage, '#plain-text');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);

    const step = itemAt(await readSteps(popupPage), 0);
    const scrollbarPixels = await readScreenshotScrollbarStats(popupPage, step.id);
    expect(scrollbarPixels.rootSentinelPixels).toBe(0);
    expect(scrollbarPixels.nestedSentinelPixels).toBeGreaterThan(0);
    expect(await rawScreenshotRosePixels(popupPage, step.id, await neutralProbeBounds(appPage))).toBe(0);
    await expectPresentationRestored(appPage, baseline);
    await stopRecording(popupPage);
  });

  test('snapshot anchor capture uses the same scrollbar-free presentation', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    const baseline = await expectRealRootScrollbar(appPage);
    expect(await readRootScrollbarSentinelPixels(appPage)).toBeGreaterThan(0);
    await installCaptureMonitor(appPage);
    await paintInteractionHostRose(appPage, 'data-howbeam-snapshot-shield');
    await startRecording(appPage, popupPage, 'snapshot');
    await expect.poll(() => appPage.evaluate(() => window.captureHostPainted)).toBe(true);

    const anchor = itemAt(await readSteps(popupPage), 0);
    expect(anchor.bounds).toBeNull();
    const scrollbarPixels = await readScreenshotScrollbarStats(popupPage, anchor.id);
    expect(scrollbarPixels.rootSentinelPixels).toBe(0);
    expect(scrollbarPixels.nestedSentinelPixels).toBeGreaterThan(0);
    expect(await rawScreenshotRosePixels(popupPage, anchor.id, await neutralProbeBounds(appPage))).toBe(0);
    await expectPresentationRestored(appPage, baseline);
    await stopRecording(popupPage);
  });

  test('restores the scrollbar when the guarded capture fails', async ({ appPage, popupPage }) => {
    const baseline = await expectRealRootScrollbar(appPage);
    expect(await readRootScrollbarSentinelPixels(appPage)).toBeGreaterThan(0);
    await startRecording(appPage, popupPage, 'steps');
    await installCaptureMonitor(appPage, true);
    await clickTarget(appPage, '#plain-text');

    await expect.poll(() => appPage.evaluate(() => window.capturePresentationMonitor.hidden)).not.toBeNull();
    await expectPresentationRestored(appPage, baseline);
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(0);
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(0);
    expect(appPage.url()).toContain('capture-must-fail=1');
    await stopRecording(popupPage);
  });
});

declare global {
  interface Window {
    capturePresentationMonitor: CaptureMonitor;
    captureHostPainted: boolean;
  }
}
