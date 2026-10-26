import { test, expect, FIXTURE_URL } from '../support/fixture';
import {
  addMovingTarget,
  clickRecordingToolbarButton,
  clickTarget,
  expectSteady,
  getStepPreviewStyle,
  hoverTarget,
  rawScreenshotRosePixels,
  readRecordingState,
  readSteps,
  resetExtensionData,
  sendRecordingControl,
  startRecording,
  startStepsRunWithFirstStep,
  stopRecording,
  storedScreenshotShowsMovingTarget,
  targetCenter,
} from '../support/harness';
import { itemAt } from '../../setup/item-at';

test.describe('step recording', () => {
  test.beforeEach(async ({ popupPage }) => {
    await resetExtensionData(popupPage);
  });

  test('previews and records generic visible elements without baking the hover frame', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'steps');
    await hoverTarget(appPage, '#plain-text');

    const preview = await getStepPreviewStyle(appPage);
    expect(preview.hidden).toBe(false);
    expect(preview.style).toContain('border: 4px solid rgb(255, 71, 71)');
    expect(preview.style).toContain('box-shadow: none');

    await clickTarget(appPage, '#plain-text');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);

    const step = itemAt(await readSteps(popupPage), 0);
    expect(step.description).toBe('標記頁面區域');
    expect(step.bounds).toMatchObject({ width: expect.any(Number), height: expect.any(Number) });
    expect(step.hasScreenshot).toBe(true);
    expect(await rawScreenshotRosePixels(popupPage, step.id)).toBe(0);

    await stopRecording(popupPage);
    await expect.poll(() => appPage.locator('[data-howbeam-step-preview]').count()).toBe(0);
  });

  test('records a manually cropped region when the auto-detected box is wrong', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'steps');
    // Region capture is the only in-page recourse for a box the detector got wrong, so it has to survive as a working path end to end.
    await clickRecordingToolbarButton(appPage, '框選區域');
    const region = appPage.locator('[data-howbeam-region-capture]');
    await expect(region).toHaveCount(1);
    await expect(region.locator('.ft-region-blocker')).toBeVisible();

    await appPage.mouse.move(120, 140);
    await appPage.mouse.down();
    await appPage.mouse.move(300, 260, { steps: 8 });
    await expect(region.locator('.ft-region-selection')).toHaveAttribute('data-visible', 'true');
    await appPage.mouse.up();
    // The box stays adjustable until it is confirmed.
    await expect(region.locator('.ft-region-selection')).toHaveAttribute('data-interactive', 'true');
    await region.locator('.ft-region-confirm').click();

    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);
    const step = itemAt(await readSteps(popupPage), 0);
    // A region carries no DOM target, so it lands as a mark with no text.
    expect(step.description).toBe('標記頁面區域');
    expect(step.hasScreenshot).toBe(true);
    expect(Math.round(step.bounds!.width)).toBe(180);
    expect(Math.round(step.bounds!.height)).toBe(120);

    // The overlay closes itself once the capture settles, leaving the ordinary hover highlight in charge again.
    await expect.poll(() => appPage.locator('[data-howbeam-region-capture]').count()).toBe(0);
    await hoverTarget(appPage, '#plain-text');

    await stopRecording(popupPage);
  });

  test('never highlights the recorder toolbar and keeps the page target frozen behind it', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'steps');
    const point = await targetCenter(appPage, '#plain-text');
    await appPage.mouse.move(point.x, point.y);
    await expect.poll(async () => (await getStepPreviewStyle(appPage)).hidden).toBe(false);
    const pageTargetStyle = (await getStepPreviewStyle(appPage)).style;

    // The toolbar pill lives in a closed shadow root, so find it by hit-testing for the point where its host answers.
    const pill = await appPage.evaluate(() => {
      for (let y = window.innerHeight - 10; y > window.innerHeight - 120; y -= 6) {
        for (let x = 20; x < window.innerWidth; x += 20) {
          if (document.elementFromPoint(x, y)?.hasAttribute('data-howbeam-recording-toolbar')) return { x, y };
        }
      }
      return null;
    });
    expect(pill).not.toBeNull();
    await appPage.mouse.move(pill!.x, pill!.y);

    // The recorder can pierce its own closed roots, so without an explicit exclusion the hit test would frame a toolbar button as page content.
    await expectSteady(async () => (await getStepPreviewStyle(appPage)).style, pageTargetStyle);

    await stopRecording(popupPage);
  });

  test('records interactive controls as clicks and replays the page handler once', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'steps');
    await clickTarget(appPage, '#action-button span');

    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);
    await expect.poll(() => appPage.evaluate(() => window.fixtureState.actionClicks)).toBe(1);
    const step = itemAt(await readSteps(popupPage), 0);
    expect(step.description).toBe('點擊按鈕');

    await stopRecording(popupPage);
  });

  test('records every click in the same step recording session', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'steps');

    await clickTarget(appPage, '#action-button span');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);

    await clickTarget(appPage, '#action-button span');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);
    await expect.poll(() => appPage.evaluate(() => window.fixtureState.actionClicks)).toBe(2);

    const steps = await readSteps(popupPage);
    expect(steps.map((step) => step.description)).toEqual(['點擊按鈕', '點擊按鈕']);

    await stopRecording(popupPage);
  });

  test('records a click that lands while the previous one is still capturing instead of dropping it', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    // The real captureVisibleTab pacing (500ms, unmocked) means two clicks back to back exercise the gesture queue's "busy" path for real.
    await startRecording(appPage, popupPage, 'steps');

    await clickTarget(appPage, '#action-button span');
    await clickTarget(appPage, '#plain-text');

    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);
    await expect.poll(() => appPage.evaluate(() => window.fixtureState.actionClicks)).toBe(1);

    const steps = await readSteps(popupPage);
    expect(steps.map((step) => step.description)).toEqual(['點擊按鈕', '標記頁面區域']);

    await stopRecording(popupPage);
  });

  test('pauses, undoes, restores, and finishes from the in-page recording lifecycle', async ({
    appPage,
    popupPage,
    extensionContext,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'steps');
    await expect(appPage.locator('[data-howbeam-recording-toolbar]')).toHaveCount(1);
    await clickTarget(appPage, '#plain-text');
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);

    const sendControl = async (type: string, undoToken?: string) => {
      return popupPage.evaluate(async ({ type, undoToken }) => {
        const extensionApi = (globalThis as unknown as {
          chrome: {
            storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
            runtime: { sendMessage(message: unknown): Promise<unknown> };
          };
        }).chrome;
        const stored = await extensionApi.storage.local.get('howbeam:recordingState');
        const runId = (stored['howbeam:recordingState'] as { runId: string }).runId;
        return extensionApi.runtime.sendMessage({ type, runId, ...(undoToken ? { undoToken } : {}) });
      }, { type, undoToken });
    };

    expect(await sendControl('PAUSE_RECORDING')).toMatchObject({ ok: true });
    await expect.poll(async () => (await readRecordingState(popupPage)).phase).toBe('paused');
    await hoverTarget(appPage, '#action-button', 'hidden');
    expect((await getStepPreviewStyle(appPage)).hidden).toBe(true);

    expect(await sendControl('RESUME_RECORDING')).toMatchObject({ ok: true });
    await expect.poll(async () => (await readRecordingState(popupPage)).phase).toBe('recording');
    await hoverTarget(appPage, '#action-button');
    expect((await getStepPreviewStyle(appPage)).hidden).toBe(false);

    const undo = await sendControl('UNDO_LAST_CAPTURE') as { ok: boolean; undoToken: string };
    expect(undo.ok).toBe(true);
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(0);
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(0);

    expect(await sendControl('RESTORE_LAST_CAPTURE', undo.undoToken)).toMatchObject({ ok: true });
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);

    const editorOpened = extensionContext.waitForEvent('page');
    expect(await sendControl('FINISH_RECORDING')).toMatchObject({ ok: true });
    const editor = await editorOpened;
    await editor.waitForLoadState('domcontentloaded');
    await expect.poll(async () => (await readRecordingState(popupPage)).isRecording).toBe(false);
    await expect(appPage.locator('[data-howbeam-recording-toolbar]')).toHaveCount(0);
    expect(editor.url()).toContain('entryId=');
    await expect(editor.getByRole('button', { name: '開啟步驟 1' })).toHaveAttribute('aria-current', 'step');
  });

  test('rejects an old run and serializes rapid finish commands', async ({
    appPage,
    popupPage,
    extensionContext,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'steps');
    const oldRunId = (await readRecordingState(popupPage)).runId as string;
    await stopRecording(popupPage);

    await startRecording(appPage, popupPage, 'steps');
    const currentRunId = (await readRecordingState(popupPage)).runId as string;
    expect(currentRunId).not.toBe(oldRunId);
    const staleResult = await popupPage.evaluate(async (runId) => {
      const extensionApi = (globalThis as unknown as {
        chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
      }).chrome;
      return extensionApi.runtime.sendMessage({ type: 'PAUSE_RECORDING', runId }) as Promise<{ ok: boolean }>;
    }, oldRunId);
    expect(staleResult.ok).toBe(false);
    await expect.poll(async () => (await readRecordingState(popupPage)).phase).toBe('recording');
    await expect.poll(async () => (await readRecordingState(popupPage)).runId).toBe(currentRunId);

    await clickTarget(appPage, '#plain-text');
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);
    const editorOpened = extensionContext.waitForEvent('page');
    const results = await Promise.all([
      sendRecordingControl(popupPage, 'FINISH_RECORDING'),
      sendRecordingControl(popupPage, 'FINISH_RECORDING'),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);

    const editor = await editorOpened;
    await editor.waitForLoadState('domcontentloaded');
    await expect.poll(async () => (await readRecordingState(editor)).isRecording).toBe(false);
    const editorBase = itemAt(editor.url().split('?'), 0);
    await expect.poll(() => extensionContext.pages().filter((page) => {
      return page.url().startsWith(editorBase);
    }).length).toBe(1);
  });

  test('keeps scrolling usable, previews below-the-fold targets, and ignores the scrollbar gutter', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'steps');

    // Bug A: a nested viewport must keep scrolling while step-recording, with the stationary pointer re-hit-tested against the revealed element.
    await hoverTarget(appPage, '#scroll-first');
    const previewBeforeScroll = await getStepPreviewStyle(appPage);
    expect(previewBeforeScroll.hidden).toBe(false);
    const scrollPoint = await appPage.locator('#scroll-viewport').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    // Virtualized sites can emit this while replacing the element under a stationary pointer; it must not clear the last viewport coordinate.
    await appPage.evaluate(({ x, y }) => {
      window.dispatchEvent(new PointerEvent('pointerout', {
        clientX: x,
        clientY: y,
        relatedTarget: null,
      }));
    }, scrollPoint);
    await appPage.mouse.wheel(0, 110);
    await expect.poll(() => appPage.locator('#scroll-viewport').evaluate((element) => element.scrollTop)).toBe(110);
    await expect.poll(() => appPage.evaluate(
      ({ x: clientX, y: clientY }) => document.elementFromPoint(clientX, clientY)?.id,
      scrollPoint,
    )).toBe('scroll-second');
    await expect.poll(async () => {
      const preview = await getStepPreviewStyle(appPage);
      return !preview.hidden && preview.style !== previewBeforeScroll.style;
    }).toBe(true);

    // A virtual list may replace the row under a stationary pointer after scrolling settles; the local observer must refresh immediately.
    const beforeReplacement = await getStepPreviewStyle(appPage);
    await appPage.evaluate(() => {
      const current = document.querySelector('#scroll-second')!;
      const replacement = document.createElement('button');
      replacement.id = 'scroll-replacement';
      replacement.textContent = '虛擬列表替換內容';
      replacement.style.cssText = 'display:block;width:180px;height:70px;margin-left:100px';
      current.replaceWith(replacement);
    });
    await expect.poll(async () => {
      const preview = await getStepPreviewStyle(appPage);
      return !preview.hidden && preview.style !== beforeReplacement.style;
    }, { timeout: 500 }).toBe(true);

    // Page-level wheel scrolling remains native too: some sites apply overflow to <body>, so its border box moves while hit-test coordinates stay viewport-relative.
    await appPage.evaluate(() => {
      document.body.style.overflowY = 'scroll';
    });
    await appPage.mouse.move(900, 400);
    const startScroll = await appPage.evaluate(() => window.scrollY);
    await appPage.mouse.wheel(0, 900);
    await expect.poll(() => appPage.evaluate(() => window.scrollY)).toBeGreaterThan(startScroll);
    expect(await appPage.evaluate(() => document.body.getBoundingClientRect().top)).toBeLessThan(0);

    // The hover preview follows a target that only exists below the fold.
    await appPage.locator('#below-fold').scrollIntoViewIfNeeded();
    await hoverTarget(appPage, '#below-fold');
    const preview = await getStepPreviewStyle(appPage);
    expect(preview.hidden).toBe(false);

    // Clicking it captures a step whose rect sits inside the viewport, with no hover frame baked into the screenshot.
    await clickTarget(appPage, '#below-fold');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);
    const belowFoldStep = itemAt(await readSteps(popupPage), 0);
    expect(belowFoldStep.description).toBe('標記頁面區域');
    const viewport = await appPage.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    expect(belowFoldStep.bounds).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
      width: expect.any(Number),
      height: expect.any(Number),
    });
    expect(belowFoldStep.bounds!.x).toBeGreaterThanOrEqual(0);
    expect(belowFoldStep.bounds!.y).toBeGreaterThanOrEqual(0);
    expect(belowFoldStep.bounds!.x + belowFoldStep.bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(belowFoldStep.bounds!.y + belowFoldStep.bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(await rawScreenshotRosePixels(popupPage, belowFoldStep.id)).toBe(0);

    // Bug A1: a pointerdown in the native scrollbar gutter must not record a step.
    const gutter = await appPage.evaluate(() => {
      const clientWidth = document.documentElement.clientWidth;
      const clientHeight = document.documentElement.clientHeight;
      return {
        x: Math.min(clientWidth + 1, window.innerWidth - 1),
        y: Math.floor(clientHeight / 2),
      };
    });
    await appPage.mouse.move(gutter.x, gutter.y);
    await appPage.mouse.down();
    await appPage.mouse.move(gutter.x, gutter.y + 120, { steps: 4 });
    await appPage.mouse.up();
    await expectSteady(async () => (await readSteps(popupPage)).length, 1);

    // The same rule applies to a nested scrollport: its scrollbar gutter is a native scroll gesture, never a generic mark on the container.
    const nestedGutter = await appPage.locator('#scroll-viewport').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.right - 2, y: rect.top + rect.height / 2 };
    });
    await appPage.mouse.move(nestedGutter.x, nestedGutter.y);
    await appPage.mouse.down();
    await appPage.mouse.move(nestedGutter.x, nestedGutter.y + 30, { steps: 2 });
    await appPage.mouse.up();
    await expectSteady(async () => (await readSteps(popupPage)).length, 1);

    await stopRecording(popupPage);
  });

  test('follows the user to another tab mid-recording and keeps capturing there and back', async ({
    appPage,
    popupPage,
    extensionContext,
    browserErrors: _browserErrors,
  }) => {
    // The E2E build grants <all_urls>, so follow mode is armed for steps runs.
    await startStepsRunWithFirstStep(appPage, popupPage);
    const firstTabId = (await readRecordingState(popupPage)).tabId as number;

    // Activate a second normal tab: the run must move with the user, not silently drop clicks there. It loads while inactive, then is activated explicitly, so the background's debounced activation always carries the final URL (never about:blank).
    const secondPage = await extensionContext.newPage();
    await secondPage.goto(`${FIXTURE_URL}navigated.html`);
    await appPage.bringToFront();
    await secondPage.bringToFront();
    await expect.poll(async () => (await readRecordingState(popupPage)).tabId).not.toBe(firstTabId);
    await expect.poll(() => secondPage.locator('[data-howbeam-step-preview]').count()).toBe(1);
    // The old tab's recorder (toolbar included) is torn down after the move.
    await expect.poll(() => appPage.locator('[data-howbeam-recording-toolbar]').count()).toBe(0);

    await clickTarget(secondPage, 'h1');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);

    // Switching back follows again and keeps appending to the same run.
    await appPage.bringToFront();
    await expect.poll(async () => (await readRecordingState(popupPage)).tabId).toBe(firstTabId);
    await expect.poll(() => appPage.locator('[data-howbeam-step-preview]').count()).toBe(1);
    await clickTarget(appPage, '#action-button span');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(3);

    await stopRecording(popupPage);
    const steps = await readSteps(popupPage);
    expect(steps.map((step) => step.sessionId)).toEqual([
      itemAt(steps, 0).sessionId,
      itemAt(steps, 0).sessionId,
      itemAt(steps, 0).sessionId,
    ]);
    expect(steps.map((step) => step.order)).toEqual([0, 1, 2]);
    await secondPage.close();
  });

  test('marks disabled controls, SVG, canvas, and general containers', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'steps');
    await appPage.evaluate(() => {
      const disabled = document.querySelector('#disabled-button');
      if (!disabled) throw new Error('Disabled fixture button is missing');
      const state = window.fixtureState as typeof window.fixtureState & { disabledEvents: number };
      state.disabledEvents = 0;
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        disabled.addEventListener(type, () => {
          state.disabledEvents += 1;
        });
      }
    });
    const selectors = ['#disabled-button', '#fixture-svg rect', '#fixture-canvas', '#visual-container strong'];
    for (const [index, selector] of selectors.entries()) {
      await clickTarget(appPage, selector);
      await expect.poll(
        async () => (await readSteps(popupPage)).length,
        { message: `expected ${selector} to create a step` },
      ).toBe(index + 1);
      await appPage.waitForTimeout(420);
    }

    const descriptions = (await readSteps(popupPage)).map((step) => step.description);
    expect(descriptions).toEqual([
      '標記頁面區域',
      '標記頁面區域',
      '標記頁面區域',
      '標記頁面區域',
    ]);
    expect(await appPage.evaluate(
      () => (window.fixtureState as typeof window.fixtureState & { disabledEvents: number }).disabledEvents,
    )).toBe(0);

    await stopRecording(popupPage);
  });

  test('boxes a moving element where the screenshot shows it, then lets it move again', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await addMovingTarget(appPage);
    await startRecording(appPage, popupPage, 'steps');
    await clickTarget(appPage, '#moving-target');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);

    const step = itemAt(await readSteps(popupPage), 0);
    expect(await storedScreenshotShowsMovingTarget(popupPage, step.id, step.bounds!)).toBe(true);
    const before = await targetCenter(appPage, '#moving-target');
    await appPage.waitForTimeout(100);
    expect(await targetCenter(appPage, '#moving-target')).not.toEqual(before);

    await stopRecording(popupPage);
  });

  test('records a pick from an autocomplete menu that closes when its field loses focus', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await appPage.goto(`${FIXTURE_URL}autocomplete.html`);
    await startRecording(appPage, popupPage, 'steps');
    await clickTarget(appPage, '#search');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);
    await appPage.keyboard.type('台北');
    await expect(appPage.locator('#suggestion')).toBeVisible();
    const suggestion = await appPage.locator('#suggestion').boundingBox();

    await clickTarget(appPage, '#suggestion');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);
    await appPage.waitForURL(/navigated\.html\?pick=taipei-101$/);

    // The step boxes the suggestion, so the menu was still open when the screenshot was taken.
    const step = itemAt(await readSteps(popupPage), 1);
    expect(step.description).toBe('開啟連結');
    expect(step.bounds!.x).toBeCloseTo(suggestion!.x, 0);
    expect(step.bounds!.width).toBeCloseTo(suggestion!.width, 0);
    await stopRecording(popupPage);
  });

  test('still takes focus off a text field when the press lands on plain content', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await appPage.goto(`${FIXTURE_URL}autocomplete.html`);
    await startRecording(appPage, popupPage, 'steps');
    await appPage.locator('#search').focus();
    await clickTarget(appPage, '#note');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);
    await expect.poll(() => appPage.evaluate(() => window.autocompleteProbe.blurs)).toBe(1);
    expect(await appPage.evaluate(() => document.activeElement === document.querySelector('#search'))).toBe(false);
    await stopRecording(popupPage);
  });
});

declare global {
  interface Window {
    fixtureState: { actionClicks: number };
    autocompleteProbe: { blurs: number };
  }
}
