import { test, expect, FIXTURE_URL } from '../support/fixture';
import {
  clickSnapshotTarget,
  expectSteady,
  getSnapshotFrame,
  readRecordingState,
  readSteps,
  resetExtensionData,
  startRecording,
  stopRecording,
} from '../support/harness';
import { itemAt } from '../../setup/item-at';

interface ProbeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DetectionCounters {
  activationOverlayClicks: number;
  activationButtonClicks: number;
  annotationShimClicks: number;
  annotationButtonClicks: number;
  paintedBackdropClicks: number;
  paintedButtonClicks: number;
  imageMapClicks: number;
}

const ZERO_COUNTERS: DetectionCounters = {
  activationOverlayClicks: 0,
  activationButtonClicks: 0,
  annotationShimClicks: 0,
  annotationButtonClicks: 0,
  paintedBackdropClicks: 0,
  paintedButtonClicks: 0,
  imageMapClicks: 0,
};
const SNAPSHOT_PREVIEW_PADDING = 8;
const IMAGE_MAP_REGION = { x: 32, y: 24, width: 96, height: 64 } as const;

type AppPage = Parameters<typeof startRecording>[0];
type SnapshotFrame = Awaited<ReturnType<typeof getSnapshotFrame>>;

async function rectOf(page: AppPage, id: string): Promise<ProbeRect> {
  return page.evaluate((target) => window.detectionProbe.rectOf(target), id);
}

async function readCounters(page: AppPage): Promise<DetectionCounters> {
  return page.evaluate(() => window.detectionProbe.readCounters());
}

function centerOf(rect: ProbeRect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function imageMapAreaBounds(image: ProbeRect): ProbeRect {
  return {
    x: image.x + IMAGE_MAP_REGION.x,
    y: image.y + IMAGE_MAP_REGION.y,
    width: IMAGE_MAP_REGION.width,
    height: IMAGE_MAP_REGION.height,
  };
}

async function clickRect(page: AppPage, rect: ProbeRect): Promise<void> {
  const point = centerOf(rect);
  await page.mouse.click(point.x, point.y);
}

async function expectTopHit(page: AppPage, rect: ProbeRect, id: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, centerOf(rect)))
    .toBe(id);
}

function expectBoundsNear(bounds: ProbeRect | null, expected: ProbeRect): void {
  expect(bounds).not.toBeNull();
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(bounds![key] - expected[key]), `${key} of captured bounds`).toBeLessThanOrEqual(1);
  }
}

function fitSnapshotPreviewBounds(bounds: ProbeRect, viewport: ProbeRect): ProbeRect {
  const left = Math.max(viewport.x, bounds.x - SNAPSHOT_PREVIEW_PADDING);
  const top = Math.max(viewport.y, bounds.y - SNAPSHOT_PREVIEW_PADDING);
  const right = Math.min(
    viewport.x + viewport.width,
    bounds.x + bounds.width + SNAPSHOT_PREVIEW_PADDING,
  );
  const bottom = Math.min(
    viewport.y + viewport.height,
    bounds.y + bounds.height + SNAPSHOT_PREVIEW_PADDING,
  );
  return { x: left, y: top, width: right - left, height: bottom - top };
}

async function expectSnapshotPreviewNear(
  frame: SnapshotFrame,
  expectedTarget: ProbeRect,
  viewport: ProbeRect,
): Promise<void> {
  const preview = frame.locator('.snapshot-box--preview');
  await expect(preview).toBeVisible();
  expectBoundsNear(await preview.boundingBox(), fitSnapshotPreviewBounds(expectedTarget, viewport));
}

async function annotationBounds(page: AppPage): Promise<ProbeRect | null> {
  const steps = await readSteps(page);
  return steps.find((step) => step.bounds !== null)?.bounds ?? null;
}

test.describe('element detection', () => {
  test.beforeEach(async ({ appPage, popupPage }) => {
    await resetExtensionData(popupPage);
    await appPage.goto(`${FIXTURE_URL}detection.html`);
  });

  test('targets the control inside a closed shadow root, not its host', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    const shadowButton = await rectOf(appPage, 'shadow-button');
    const host = await rectOf(appPage, 'closed-host');
    await startRecording(appPage, popupPage, 'steps');
    await clickRect(appPage, shadowButton);

    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);
    const step = itemAt(await readSteps(popupPage), 0);
    // Without closed-root access the hit test stops at the host, which would record the whole 320x160 block as an unlabelled region.
    expect(step.description).toBe('點擊按鈕');
    expectBoundsNear(step.bounds, shadowButton);
    expect(step.bounds!.width).toBeLessThan(host.width);

    await stopRecording(popupPage);
  });

  test('records delegated click bindings as controls', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    const jsaction = await rectOf(appPage, 'jsaction-card');
    const stimulus = await rectOf(appPage, 'stimulus-card');
    await startRecording(appPage, popupPage, 'steps');
    await clickRect(appPage, jsaction);
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);
    await clickRect(appPage, stimulus);
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);

    const steps = await readSteps(popupPage);
    // Neither card has a role, href, handler property or pointer cursor: the framework attribute is the only evidence they're controls.
    expect(steps.map((step) => step.description)).toEqual(['點擊互動元素', '點擊互動元素']);
    expectBoundsNear(itemAt(steps, 0).bounds, jsaction);
    expectBoundsNear(itemAt(steps, 1).bounds, stimulus);

    await stopRecording(popupPage);
  });

  test('steps capture and replay an image-map area exactly once', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    const image = await rectOf(appPage, 'image-map-image');
    const area = imageMapAreaBounds(image);
    await expectTopHit(appPage, area, 'image-map-area');

    await startRecording(appPage, popupPage, 'steps');
    await clickRect(appPage, area);

    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);
    await expect.poll(() => readCounters(appPage)).toEqual({
      ...ZERO_COUNTERS,
      imageMapClicks: 1,
    });
    const step = itemAt(await readSteps(popupPage), 0);
    expect(step.description).toBe('開啟連結');
    expectBoundsNear(step.bounds, area);

    await stopRecording(popupPage);
  });

  test('snapshot previews and commits an image-map area without dispatching its click', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    const image = await rectOf(appPage, 'image-map-image');
    const area = imageMapAreaBounds(image);
    const viewport = await appPage.evaluate(() => ({
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    await expectTopHit(appPage, area, 'image-map-area');

    await startRecording(appPage, popupPage, 'snapshot');
    const shield = await getSnapshotFrame(appPage);
    const point = centerOf(area);
    await shield.locator('body').hover({ position: point });
    await expectSnapshotPreviewNear(shield, area, viewport);

    await clickSnapshotTarget(appPage, point);
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(1);
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);
    expectBoundsNear(await annotationBounds(popupPage), area);
    await expectSteady(() => readCounters(appPage), ZERO_COUNTERS);

    await stopRecording(popupPage);
  });

  test('steps preserve a transparent overlay as the activation target and replay it once', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    const coveredButton = await rectOf(appPage, 'activation-covered-button');
    await appPage.evaluate(() => window.detectionProbe.armActivationOverlay());
    const overlay = await rectOf(appPage, 'activation-transparent-overlay');
    await expectTopHit(appPage, coveredButton, 'activation-transparent-overlay');

    await startRecording(appPage, popupPage, 'steps');
    await clickRect(appPage, coveredButton);

    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);
    await expect.poll(() => readCounters(appPage)).toEqual({
      ...ZERO_COUNTERS,
      activationOverlayClicks: 1,
    });
    const step = itemAt(await readSteps(popupPage), 0);
    expect(step.description).toBe('點擊互動元素');
    expectBoundsNear(step.bounds, overlay);
    expect(step.bounds!.width).toBeGreaterThan(coveredButton.width);
    expect(step.bounds!.height).toBeGreaterThan(coveredButton.height);

    await stopRecording(popupPage);
  });

  test('snapshot pierces a paintless semantic-free shim without dispatching page clicks', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    const coveredButton = await rectOf(appPage, 'annotation-covered-button');
    await appPage.evaluate(() => window.detectionProbe.armAnnotationOverlay());
    const shim = await rectOf(appPage, 'annotation-transparent-shim');
    const viewport = await appPage.evaluate(() => ({
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    await expectTopHit(appPage, coveredButton, 'annotation-transparent-shim');

    await startRecording(appPage, popupPage, 'snapshot');
    const shield = await getSnapshotFrame(appPage);
    const point = centerOf(coveredButton);
    await shield.locator('body').hover({ position: point });
    await expectSnapshotPreviewNear(shield, coveredButton, viewport);
    const previewBounds = await shield.locator('.snapshot-box--preview').boundingBox();
    expect(previewBounds!.width).toBeLessThan(shim.width);
    expect(previewBounds!.height).toBeLessThan(shim.height);

    await clickSnapshotTarget(appPage, point);
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(1);
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);
    expectBoundsNear(await annotationBounds(popupPage), coveredButton);
    await expectSteady(() => readCounters(appPage), ZERO_COUNTERS);

    await stopRecording(popupPage);
  });

  test('snapshot does not pierce a blank child whose exclusive overlay ancestor paints', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    const coveredButton = await rectOf(appPage, 'painted-ancestor-button');
    await appPage.evaluate(() => window.detectionProbe.armPaintedAncestor());
    const overlay = await rectOf(appPage, 'painted-ancestor-overlay');
    const viewport = await appPage.evaluate(() => ({
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    await expectTopHit(appPage, coveredButton, 'painted-ancestor-hit-surface');

    await startRecording(appPage, popupPage, 'snapshot');
    const shield = await getSnapshotFrame(appPage);
    const point = centerOf(coveredButton);
    await shield.locator('body').hover({ position: point });
    await expectSnapshotPreviewNear(shield, overlay, viewport);

    await clickSnapshotTarget(appPage, point);
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(1);
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);
    expectBoundsNear(await annotationBounds(popupPage), overlay);
    await expectSteady(() => readCounters(appPage), ZERO_COUNTERS);

    await stopRecording(popupPage);
  });

  test('snapshot keeps paint owned by a pointer-events-none descendant', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    const coveredButton = await rectOf(appPage, 'painted-descendant-button');
    await appPage.evaluate(() => window.detectionProbe.armPaintedDescendant());
    const overlay = await rectOf(appPage, 'painted-descendant-overlay');
    const viewport = await appPage.evaluate(() => ({
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    await expectTopHit(appPage, coveredButton, 'painted-descendant-overlay');

    await startRecording(appPage, popupPage, 'snapshot');
    const shield = await getSnapshotFrame(appPage);
    const point = centerOf(coveredButton);
    await shield.locator('body').hover({ position: point });
    await expectSnapshotPreviewNear(shield, overlay, viewport);

    await clickSnapshotTarget(appPage, point);
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(1);
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);
    expectBoundsNear(await annotationBounds(popupPage), overlay);
    await expectSteady(() => readCounters(appPage), ZERO_COUNTERS);

    await stopRecording(popupPage);
  });

  test('snapshot keeps a backdrop painted by ::before', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    const coveredButton = await rectOf(appPage, 'pseudo-painted-button');
    await appPage.evaluate(() => window.detectionProbe.armPseudoPainted());
    const overlay = await rectOf(appPage, 'pseudo-painted-overlay');
    const viewport = await appPage.evaluate(() => ({
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    await expectTopHit(appPage, coveredButton, 'pseudo-painted-overlay');

    await startRecording(appPage, popupPage, 'snapshot');
    const shield = await getSnapshotFrame(appPage);
    const point = centerOf(coveredButton);
    await shield.locator('body').hover({ position: point });
    await expectSnapshotPreviewNear(shield, overlay, viewport);

    await clickSnapshotTarget(appPage, point);
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(1);
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);
    expectBoundsNear(await annotationBounds(popupPage), overlay);
    await expectSteady(() => readCounters(appPage), ZERO_COUNTERS);

    await stopRecording(popupPage);
  });

  test('snapshot keeps generated paint outside its 1px originating box', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    const coveredButton = await rectOf(appPage, 'pseudo-overflow-button');
    await appPage.evaluate(() => window.detectionProbe.armPseudoOverflow());
    const host = await rectOf(appPage, 'pseudo-overflow-host');
    const viewport = await appPage.evaluate(() => ({
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    await expectTopHit(appPage, coveredButton, 'pseudo-overflow-host');
    expect(host.width).toBe(1);
    expect(host.height).toBe(1);

    await startRecording(appPage, popupPage, 'snapshot');
    const shield = await getSnapshotFrame(appPage);
    const point = centerOf(coveredButton);
    await shield.locator('body').hover({ position: point });
    await expectSnapshotPreviewNear(shield, host, viewport);

    await clickSnapshotTarget(appPage, point);
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(1);
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);
    expectBoundsNear(await annotationBounds(popupPage), host);
    await expectSteady(() => readCounters(appPage), ZERO_COUNTERS);

    await stopRecording(popupPage);
  });

  test('snapshot does not pierce a painted non-interactive layer below a blank shim', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    const coveredButton = await rectOf(appPage, 'painted-intermediate-button');
    await appPage.evaluate(() => window.detectionProbe.armPaintedIntermediate());
    const shim = await rectOf(appPage, 'painted-intermediate-shim');
    const viewport = await appPage.evaluate(() => ({
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    await expectTopHit(appPage, coveredButton, 'painted-intermediate-shim');

    await startRecording(appPage, popupPage, 'snapshot');
    const shield = await getSnapshotFrame(appPage);
    const point = centerOf(coveredButton);
    await shield.locator('body').hover({ position: point });
    await expectSnapshotPreviewNear(shield, shim, viewport);

    await clickSnapshotTarget(appPage, point);
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(1);
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);
    expectBoundsNear(await annotationBounds(popupPage), shim);
    await expectSteady(() => readCounters(appPage), ZERO_COUNTERS);

    await stopRecording(popupPage);
  });

  test('steps keep a full-viewport painted backdrop above its covered button', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    const coveredButton = await rectOf(appPage, 'painted-covered-button');
    await appPage.evaluate(() => window.detectionProbe.armPaintedBackdrop());
    const backdrop = await rectOf(appPage, 'painted-backdrop');
    await expectTopHit(appPage, coveredButton, 'painted-backdrop');

    await startRecording(appPage, popupPage, 'steps');
    await clickRect(appPage, coveredButton);

    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);
    await expect.poll(() => readCounters(appPage)).toEqual({
      ...ZERO_COUNTERS,
      paintedBackdropClicks: 1,
    });
    const step = itemAt(await readSteps(popupPage), 0);
    expect(step.description).toBe('標記頁面區域');
    expectBoundsNear(step.bounds, backdrop);
    expect(step.bounds!.width).toBeGreaterThan(coveredButton.width);
    expect(step.bounds!.height).toBeGreaterThan(coveredButton.height);

    await stopRecording(popupPage);
  });

  test('snapshot keeps a full-viewport painted backdrop above its covered button', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    const coveredButton = await rectOf(appPage, 'painted-covered-button');
    await appPage.evaluate(() => window.detectionProbe.armPaintedBackdrop());
    const backdrop = await rectOf(appPage, 'painted-backdrop');
    await expectTopHit(appPage, coveredButton, 'painted-backdrop');

    await startRecording(appPage, popupPage, 'snapshot');
    const shield = await getSnapshotFrame(appPage);
    const point = centerOf(coveredButton);
    await shield.locator('body').hover({ position: point });
    await expectSnapshotPreviewNear(shield, backdrop, backdrop);

    await clickSnapshotTarget(appPage, point);
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(1);
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);
    expectBoundsNear(await annotationBounds(popupPage), backdrop);
    await expectSteady(() => readCounters(appPage), ZERO_COUNTERS);

    await stopRecording(popupPage);
  });
});

declare global {
  interface Window {
    detectionProbe: {
      rectOf(id: string): ProbeRect;
      armActivationOverlay(): void;
      armAnnotationOverlay(): void;
      armPaintedAncestor(): void;
      armPaintedIntermediate(): void;
      armPaintedDescendant(): void;
      armPseudoPainted(): void;
      armPseudoOverflow(): void;
      armPaintedBackdrop(): void;
      noteActivationOverlayClick(): void;
      noteActivationButtonClick(): void;
      noteAnnotationButtonClick(): void;
      notePaintedButtonClick(): void;
      noteImageMapClick(): void;
      readCounters(): DetectionCounters;
    };
  }
}
