import { test, expect, FIXTURE_URL } from '../support/fixture';
import {
  captureNavLinkClickStep,
  captureNavigatedHeadingStep,
  clickSnapshotTarget,
  clickTarget,
  expectStepCount,
  expectSteady,
  getSnapshotFrame,
  readRecordingState,
  readSteps,
  resetExtensionData,
  startRecording,
  stopRecording,
} from '../support/harness';
import { itemAt } from '../../setup/item-at';

test.describe('frames and recording lifecycle', () => {
  test.beforeEach(async ({ popupPage }) => {
    await resetExtensionData(popupPage);
  });

  test('records targets in cross-origin and nested frames', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await appPage.goto(`${FIXTURE_URL}frames-host.html`);
    await startRecording(appPage, popupPage, 'snapshot');
    const outer = appPage.frameLocator('#cross-origin-frame');
    const outerBox = await outer.locator('#frame-text').boundingBox();
    if (!outerBox) throw new Error('Cross-origin frame target has no box');
    await clickSnapshotTarget(appPage, {
      x: outerBox.x + outerBox.width / 2,
      y: outerBox.y + outerBox.height / 2,
    });
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);

    const nested = outer.frameLocator('#nested-frame');
    const outerFrameMetrics = await appPage.locator('#cross-origin-frame').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, borderLeft: element.clientLeft, borderTop: element.clientTop };
    });
    const nestedFrameMetrics = await outer.locator('#nested-frame').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, borderLeft: element.clientLeft, borderTop: element.clientTop };
    });
    const nestedTargetMetrics = await nested.locator('#nested-text').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    const nestedPoint = {
      x:
        outerFrameMetrics.x + outerFrameMetrics.borderLeft + nestedFrameMetrics.x +
        nestedFrameMetrics.borderLeft + nestedTargetMetrics.x + nestedTargetMetrics.width / 2,
      y:
        outerFrameMetrics.y + outerFrameMetrics.borderTop + nestedFrameMetrics.y +
        nestedFrameMetrics.borderTop + nestedTargetMetrics.y + nestedTargetMetrics.height / 2,
    };
    const shield = await getSnapshotFrame(appPage);
    await shield.locator('body').hover({
      position: nestedPoint,
    });
    await expect(shield.locator('.snapshot-box--preview')).toBeVisible();
    await clickSnapshotTarget(appPage, nestedPoint);
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(3);

    expect((await readSteps(popupPage)).map((step) => step.description).filter(Boolean)).toEqual([
      '標記頁面區域',
      '標記頁面區域',
    ]);
    await stopRecording(popupPage);
  });

  test('rejects a page-forged cross-origin child-frame step relay', async ({
    appPage,
    popupPage,
    extensionId,
    browserErrors: _browserErrors,
  }) => {
    await appPage.goto(`${FIXTURE_URL}frames-host.html`);
    const outer = appPage.frameLocator('#cross-origin-frame');
    const button = outer.locator('#frame-button');
    await expect(button).toBeVisible();
    await button.evaluate((element) => {
      element.setAttribute('data-click-count', '0');
      element.addEventListener('click', () => {
        const count = Number(element.getAttribute('data-click-count') ?? '0');
        element.setAttribute('data-click-count', String(count + 1));
      });
    });
    await startRecording(appPage, popupPage, 'steps');

    await button.evaluate((element, messageType) => {
      const rect = element.getBoundingClientRect();
      window.parent.postMessage({
        type: messageType,
        captureId: 'forged-capture-id',
        relayToken: 'forged-relay-token',
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      }, '*');
    }, `howbeam_step_frame_click_${extensionId}`);

    await expectSteady(async () => (await readSteps(popupPage)).length, 0);

    // A genuine click proves the recorder was live while the forged public hop was ignored, and gives a deterministic barrier for replay.
    await button.click();
    await expect.poll(() => button.getAttribute('data-click-count')).toBe('1');
    await expectStepCount(popupPage, 1);
    await expectSteady(async () => (await readSteps(popupPage)).length, 1);
    await stopRecording(popupPage);
  });

  test('ignores a synthetic pointerdown dispatched by child-frame page script', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await appPage.goto(`${FIXTURE_URL}frames-host.html`);
    const button = appPage.frameLocator('#cross-origin-frame').locator('#frame-button');
    await expect(button).toBeVisible();
    await button.evaluate((element) => {
      element.setAttribute('data-click-count', '0');
      element.setAttribute('data-pointerdown-count', '0');
      element.addEventListener('click', () => {
        const count = Number(element.getAttribute('data-click-count') ?? '0');
        element.setAttribute('data-click-count', String(count + 1));
      });
      element.addEventListener('pointerdown', () => {
        const count = Number(element.getAttribute('data-pointerdown-count') ?? '0');
        element.setAttribute('data-pointerdown-count', String(count + 1));
      });
    });
    await startRecording(appPage, popupPage, 'steps');

    const syntheticWasTrusted = await button.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const event = new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
        buttons: 1,
        clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2,
        isPrimary: true,
        pointerId: 1,
        pointerType: 'mouse',
      });
      element.dispatchEvent(event);
      return event.isTrusted;
    });

    expect(syntheticWasTrusted).toBe(false);
    expect(await button.getAttribute('data-pointerdown-count')).toBe('1');
    await expectSteady(async () => (await readSteps(popupPage)).length, 0);

    // The following trusted input must still record and replay once, proving the zero-step result was the trust check, not missing instrumentation.
    await button.click();
    await expect.poll(() => button.getAttribute('data-click-count')).toBe('1');
    await expectStepCount(popupPage, 1);
    await expectSteady(async () => (await readSteps(popupPage)).length, 1);
    await stopRecording(popupPage);
  });

  test('records and replays real cross-origin and nested-frame clicks exactly once', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await appPage.goto(`${FIXTURE_URL}frames-host.html`);
    const outer = appPage.frameLocator('#cross-origin-frame');
    const outerButton = outer.locator('#frame-button');
    const nestedText = outer.frameLocator('#nested-frame').locator('#nested-text');
    await expect(outerButton).toBeVisible();
    await expect(nestedText).toBeVisible();
    for (const target of [outerButton, nestedText]) {
      await target.evaluate((element) => {
        element.setAttribute('data-click-count', '0');
        element.addEventListener('click', () => {
          const count = Number(element.getAttribute('data-click-count') ?? '0');
          element.setAttribute('data-click-count', String(count + 1));
        });
      });
    }
    await startRecording(appPage, popupPage, 'steps');

    await outerButton.click();
    await expect.poll(() => outerButton.getAttribute('data-click-count')).toBe('1');
    await expectStepCount(popupPage, 1);
    await expectSteady(async () => (await readSteps(popupPage)).length, 1);

    const outerFrameMetrics = await appPage.locator('#cross-origin-frame').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, borderLeft: element.clientLeft, borderTop: element.clientTop };
    });
    const nestedFrameMetrics = await outer.locator('#nested-frame').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, borderLeft: element.clientLeft, borderTop: element.clientTop };
    });
    const nestedTargetMetrics = await nestedText.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    await appPage.mouse.click(
      outerFrameMetrics.x + outerFrameMetrics.borderLeft + nestedFrameMetrics.x +
        nestedFrameMetrics.borderLeft + nestedTargetMetrics.x + nestedTargetMetrics.width / 2,
      outerFrameMetrics.y + outerFrameMetrics.borderTop + nestedFrameMetrics.y +
        nestedFrameMetrics.borderTop + nestedTargetMetrics.y + nestedTargetMetrics.height / 2,
    );
    await expect.poll(() => nestedText.getAttribute('data-click-count')).toBe('1');
    await expectStepCount(popupPage, 2);
    await expectSteady(async () => (await readSteps(popupPage)).length, 2);
    await expectSteady(async () => outerButton.getAttribute('data-click-count'), '1');
    await stopRecording(popupPage);
  });

  test('records two relayed frame clicks fired back to back instead of dropping the second', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await appPage.goto(`${FIXTURE_URL}frames-host.html`);
    const outer = appPage.frameLocator('#cross-origin-frame');
    const outerButton = outer.locator('#frame-button');
    const nestedText = outer.frameLocator('#nested-frame').locator('#nested-text');
    await expect(outerButton).toBeVisible();
    await expect(nestedText).toBeVisible();
    for (const target of [outerButton, nestedText]) {
      await target.evaluate((element) => {
        element.setAttribute('data-click-count', '0');
        element.addEventListener('click', () => {
          const count = Number(element.getAttribute('data-click-count') ?? '0');
          element.setAttribute('data-click-count', String(count + 1));
        });
      });
    }
    await startRecording(appPage, popupPage, 'steps');

    const outerFrameMetrics = await appPage.locator('#cross-origin-frame').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, borderLeft: element.clientLeft, borderTop: element.clientTop };
    });
    const nestedFrameMetrics = await outer.locator('#nested-frame').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, borderLeft: element.clientLeft, borderTop: element.clientTop };
    });
    const nestedTargetMetrics = await nestedText.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    const nestedPoint = {
      x:
        outerFrameMetrics.x + outerFrameMetrics.borderLeft + nestedFrameMetrics.x +
        nestedFrameMetrics.borderLeft + nestedTargetMetrics.x + nestedTargetMetrics.width / 2,
      y:
        outerFrameMetrics.y + outerFrameMetrics.borderTop + nestedFrameMetrics.y +
        nestedFrameMetrics.borderTop + nestedTargetMetrics.y + nestedTargetMetrics.height / 2,
    };

    // Fired back to back with no wait in between: the shared gesture queue must not drop the second hop just because the first is still capturing.
    await outerButton.click();
    await appPage.mouse.click(nestedPoint.x, nestedPoint.y);

    await expect.poll(() => outerButton.getAttribute('data-click-count')).toBe('1');
    await expect.poll(() => nestedText.getAttribute('data-click-count')).toBe('1');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);
    await stopRecording(popupPage);
  });

  test('falls back to the visible iframe box when a sandboxed frame is inaccessible', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await appPage.goto(`${FIXTURE_URL}sandbox-host.html`);
    await startRecording(appPage, popupPage, 'snapshot');
    await appPage.locator('#sandbox-frame').evaluate((element) => {
      element.replaceWith(element.cloneNode(true));
    });
    await expect(appPage.frameLocator('#sandbox-frame').locator('body')).toContainText('sandbox 純文字');
    const frameBox = await appPage.locator('#sandbox-frame').boundingBox();
    if (!frameBox) throw new Error('Sandbox frame has no box');
    await clickSnapshotTarget(appPage, {
      x: frameBox.x + frameBox.width / 2,
      y: frameBox.y + frameBox.height / 2,
    });

    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);
    const annotation = (await readSteps(popupPage)).find((step) => step.bounds !== null);
    expect(annotation?.description).toBe('標記頁面區域');
    expect(annotation?.bounds?.width).toBeGreaterThan(500);
    await stopRecording(popupPage);
  });

  test('stops a snapshot run when its document navigates', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot');
    await appPage.goto(`${FIXTURE_URL}navigated.html`);

    await expect.poll(async () => (await readRecordingState(popupPage)).isRecording).toBe(false);
    expect((await readRecordingState(popupPage)).error).toBe('錄製已停止，因為快照頁面已變更。');
    await expect.poll(() => appPage.locator('[data-howbeam-snapshot-shield]').count()).toBe(0);
  });

  test('reinjects step recording after a top-level navigation', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'steps');
    await appPage.goto(`${FIXTURE_URL}navigated.html`);

    await captureNavigatedHeadingStep(appPage, popupPage);
    await expectStepCount(popupPage, 1);
    expect((await readSteps(popupPage))[0]?.description).toBe('標記頁面區域');
    await stopRecording(popupPage);
  });

  test('captures a real link click, lets it navigate, and keeps recording on the new page', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await captureNavLinkClickStep(appPage, popupPage);
    const linkStep = itemAt(await readSteps(popupPage), 0);
    expect(linkStep.description).toBe('開啟連結');
    expect(linkStep.hasScreenshot).toBe(true);

    // The run survives the navigation and the re-injected recorder captures the next step on the new document.
    await captureNavigatedHeadingStep(appPage, popupPage);
    await expectStepCount(popupPage, 2);
    await stopRecording(popupPage);
  });

  test('captures a history back button and preserves its navigation', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await captureNavLinkClickStep(appPage, popupPage);
    await clickTarget(appPage, '#history-back');

    await appPage.waitForURL((url) => !url.pathname.endsWith('/navigated.html'));
    await expectStepCount(popupPage, 2);
    await stopRecording(popupPage);
  });

  test('going back after the run ended does not resurrect a recorder on the restored page', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await captureNavLinkClickStep(appPage, popupPage);
    await stopRecording(popupPage);

    // The document went into the back/forward cache with its recorder still live and never got the stop message; on restore it must tear itself down.
    await appPage.goBack();
    await appPage.waitForURL((url) => !url.href.includes('navigated'));
    await expect.poll(() => appPage.locator('[data-howbeam-step-preview]').count()).toBe(0);
    await expect.poll(() => appPage.locator('[data-howbeam-recording-toolbar]').count()).toBe(0);
    await clickTarget(appPage, '#action-button span');
    await expect.poll(() => appPage.evaluate(() => window.fixtureState.actionClicks)).toBe(1);
    await expectSteady(async () => (await readSteps(popupPage)).length, 1);
  });

  test('removes an empty snapshot anchor on stop', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot');
    expect(await readSteps(popupPage)).toHaveLength(1);
    await stopRecording(popupPage);
    expect(await readSteps(popupPage)).toHaveLength(0);
  });
});
