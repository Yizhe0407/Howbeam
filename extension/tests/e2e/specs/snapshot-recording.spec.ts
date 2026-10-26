import { test, expect, FIXTURE_URL } from '../support/fixture';
import {
  addMovingTarget,
  clickShieldClosingControl,
  clickSnapshotTarget,
  expectSteady,
  getSnapshotFrame,
  readPageScreenshotPixel,
  readRecordingState,
  readSteps,
  resetExtensionData,
  sendRecordingControl,
  startRecording,
  stopRecording,
  storedScreenshotShowsMovingTarget,
  targetCenter,
} from '../support/harness';

test.describe('snapshot recording', () => {
  test.beforeEach(async ({ popupPage }) => {
    await resetExtensionData(popupPage);
  });

  test('keeps host pages visible across page and browser color schemes', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    const sentinelPixel = { red: 12, green: 200, blue: 90, alpha: 255 };
    await appPage.evaluate(() => {
      const sentinel = document.createElement('div');
      sentinel.id = 'snapshot-transparency-sentinel';
      Object.assign(sentinel.style, {
        position: 'fixed',
        left: '24px',
        top: '300px',
        width: '120px',
        height: '120px',
        zIndex: '2147480000',
        background: 'rgb(12, 200, 90)',
      });
      document.body.append(sentinel);
    });

    for (const hostScheme of ['light', 'dark'] as const) {
      for (const preferredScheme of ['light', 'dark'] as const) {
        await appPage.emulateMedia({ colorScheme: preferredScheme });
        await appPage.evaluate((scheme) => {
          document.documentElement.style.colorScheme = scheme;
        }, hostScheme);
        expect(await readPageScreenshotPixel(appPage, 40, 320)).toEqual(sentinelPixel);

        await startRecording(appPage, popupPage, 'snapshot');
        const shield = await getSnapshotFrame(appPage);

        expect(await shield.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('light only');
        expect(await readPageScreenshotPixel(appPage, 40, 320)).toEqual(sentinelPixel);

        await stopRecording(popupPage);
        await expect.poll(() => appPage.locator('[data-howbeam-snapshot-shield]').count()).toBe(0);
      }
    }
  });

  test('shows hover preview, commits numbered marks, and deduplicates the same target', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot');
    const point = await targetCenter(appPage, '#plain-text');
    const shield = await getSnapshotFrame(appPage);

    await shield.locator('body').hover({ position: point });
    await expect(shield.locator('.snapshot-box--preview')).toBeVisible();
    await expect(shield.locator('body')).toHaveClass(/has-preview-target/);

    await clickSnapshotTarget(appPage, point);
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(1);
    await expect(shield.locator('.snapshot-annotation__badge-label')).toHaveText('1');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);

    await clickSnapshotTarget(appPage, point);
    await expectSteady(async () => (await readSteps(popupPage)).length, 2);
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(1);

    const steps = await readSteps(popupPage);
    const anchor = steps.find((step) => step.bounds === null);
    const annotation = steps.find((step) => step.bounds !== null);
    expect(anchor).toMatchObject({ hasScreenshot: true, groupId: expect.any(String) });
    expect(annotation).toMatchObject({ hasScreenshot: false, description: '標記頁面區域' });
    expect(annotation?.groupId).toBe(anchor?.id);

    await stopRecording(popupPage);
    await expect.poll(() => appPage.locator('[data-howbeam-snapshot-shield]').count()).toBe(0);
  });

  test('isolates page input while the shield holds focus', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot');
    const point = await targetCenter(appPage, '#plain-text');
    const shield = await getSnapshotFrame(appPage);

    await shield.locator('body').hover({ position: point });
    await expect.poll(() => shield.evaluate(() => document.hasFocus())).toBe(true);
    await expect.poll(() => appPage.evaluate(() => document.activeElement?.hasAttribute('data-howbeam-snapshot-shield'))).toBe(true);
    await expect(shield.locator('.snapshot-box--preview')).toBeVisible();

    await clickSnapshotTarget(appPage, point);
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);
    expect(await appPage.evaluate(() => window.fixtureState.actionClicks)).toBe(0);

    await stopRecording(popupPage);
  });

  test('resolves each pointer position independently across wrapper depths', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot');
    const shallow = await targetCenter(appPage, '#plain-text');
    const deep = await targetCenter(appPage, '#deep-text');
    const card = await appPage.locator('#plain-card').boundingBox();
    const deepText = await appPage.locator('#deep-text').boundingBox();
    const shield = await getSnapshotFrame(appPage);

    await appPage.mouse.move(shallow.x, shallow.y);
    await expect(shield.locator('.snapshot-box--preview')).toBeVisible();
    const shallowStyle = await shield.locator('.snapshot-box--preview').getAttribute('style');

    // Nothing is retained between points: the deeply wrapped text answers with its own box, and returning to the first point restores it.
    await appPage.mouse.move(deep.x, deep.y);
    await expect.poll(() => shield.locator('.snapshot-box--preview').getAttribute('style')).not.toBe(shallowStyle);
    await appPage.mouse.move(shallow.x, shallow.y);
    await expect.poll(() => shield.locator('.snapshot-box--preview').getAttribute('style')).toBe(shallowStyle);

    await appPage.mouse.move(deep.x, deep.y);
    await clickSnapshotTarget(appPage, deep);
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);
    const annotation = (await readSteps(popupPage)).find((step) => step.bounds !== null);
    expect(Math.round(annotation!.bounds!.width)).toBe(Math.round(deepText!.width));
    expect(Math.round(annotation!.bounds!.width)).not.toBe(Math.round(card!.width));

    await stopRecording(popupPage);
  });

  test('undoes, restores, and finishes through the snapshot shield toolbar', async ({
    appPage,
    popupPage,
    extensionContext,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot');
    const shield = await getSnapshotFrame(appPage);
    const point = await targetCenter(appPage, '#plain-text');
    await expect(shield.getByRole('button', { name: '完成', exact: true })).toBeVisible();

    await clickSnapshotTarget(appPage, point);
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);
    await shield.getByRole('button', { name: '復原上一個' }).click();
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(0);
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);
    await expect(shield.locator('.ft-snackbar')).toContainText('已移除標註 1');

    await shield.getByRole('button', { name: '還原' }).click();
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(1);
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);

    const editorOpened = extensionContext.waitForEvent('page');
    await clickShieldClosingControl(shield.getByRole('button', { name: '完成', exact: true }));
    const editor = await editorOpened;
    await editor.waitForLoadState('domcontentloaded');
    await expect.poll(async () => (await readRecordingState(popupPage)).isRecording).toBe(false);
    await expect.poll(() => appPage.locator('[data-howbeam-snapshot-shield]').count()).toBe(0);
    // Finishing hands the editor the snapshot group, not its last annotation: entryId is the anchor id, the timeline entry the rail selects.
    const finishedAnchor = (await readSteps(popupPage)).find((step) => step.bounds === null);
    expect(new URL(editor.url()).searchParams.get('entryId')).toBe(finishedAnchor?.id);
    await expect(editor.getByRole('button', { name: '開啟步驟 1' })).toHaveAttribute('aria-current', 'step');
  });

  test('keeps the drawn marks and the duplicate check in step with an undo sent from outside the shield', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot');
    const shield = await getSnapshotFrame(appPage);
    const point = await targetCenter(appPage, '#plain-text');
    await clickSnapshotTarget(appPage, point);
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);

    // The undo-last-capture keyboard shortcut reaches the background the same way.
    const undone = await sendRecordingControl(popupPage, 'UNDO_LAST_CAPTURE') as { ok: boolean; undoToken?: string };
    expect(undone.ok).toBe(true);
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(0);
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(0);

    expect(await sendRecordingControl(popupPage, 'RESTORE_LAST_CAPTURE', undone.undoToken)).toMatchObject({ ok: true });
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(1);
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);

    expect(await sendRecordingControl(popupPage, 'UNDO_LAST_CAPTURE')).toMatchObject({ ok: true });
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(0);
    // The undone target is free to be marked again instead of being taken for a duplicate.
    await clickSnapshotTarget(appPage, point);
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(1);
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);
    await stopRecording(popupPage);
  });

  test('moves and persists the toolbar, then discards the current run after confirmation', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot');
    const shield = await getSnapshotFrame(appPage);
    await clickSnapshotTarget(appPage, await targetCenter(appPage, '#plain-text'));
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);
    const readToolbarCorner = () => popupPage.evaluate(async () => {
      const extensionApi = (globalThis as unknown as {
        chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
      }).chrome;
      const result = await extensionApi.storage.local.get('howbeam:recordingToolbarCorner');
      return result['howbeam:recordingToolbarCorner'];
    });

    const positionControl = shield.getByRole('button', { name: /拖曳移動/ });
    const handle = await positionControl.boundingBox();
    const viewportHeight = await appPage.evaluate(() => window.innerHeight);
    expect(handle).not.toBeNull();
    await appPage.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
    await appPage.mouse.down();
    await appPage.mouse.move(40, viewportHeight - 40, { steps: 6 });
    await appPage.mouse.up();
    await expect.poll(() => shield.locator('.ft-toolbar').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: Math.round(rect.left),
        bottom: Math.round(window.innerHeight - rect.bottom),
      };
    })).toEqual({ left: 16, bottom: 16 });
    await expect.poll(readToolbarCorner).toBe('bottom-left');

    await shield.getByRole('button', { name: '放棄這次錄製' }).click();
    await expect(shield.getByRole('alertdialog', { name: '放棄這次錄製？' })).toBeVisible();
    await clickShieldClosingControl(shield.getByRole('button', { name: '放棄錄製' }));

    await expect.poll(async () => (await readRecordingState(popupPage)).isRecording).toBe(false);
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(0);
    await expect.poll(() => appPage.locator('[data-howbeam-snapshot-shield]').count()).toBe(0);
  });

  test('creates independent snapshot groups after releasing the page for navigation', async ({
    appPage,
    popupPage,
    extensionContext,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot');
    const firstShield = await getSnapshotFrame(appPage);
    await clickSnapshotTarget(appPage, await targetCenter(appPage, '#plain-text'));
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);

    await clickShieldClosingControl(firstShield.getByRole('button', { name: '下一張' }));
    await expect.poll(async () => (await readRecordingState(popupPage)).phase).toBe('preparing-next');
    await expect.poll(() => appPage.locator('[data-howbeam-snapshot-shield]').count()).toBe(0);
    await expect(appPage.locator('[data-howbeam-recording-toolbar]')).toHaveCount(1);

    await appPage.goto(`${FIXTURE_URL}navigated.html`);
    await expect.poll(async () => (await readRecordingState(popupPage)).phase).toBe('preparing-next');
    await expect.poll(() => appPage.locator('[data-howbeam-recording-toolbar]').count()).toBe(1);

    const createResults = await Promise.all([
      sendRecordingControl(popupPage, 'CREATE_NEXT_SNAPSHOT'),
      sendRecordingControl(popupPage, 'CREATE_NEXT_SNAPSHOT'),
    ]);
    expect(createResults.filter((result) => result.ok)).toHaveLength(1);
    expect(createResults.filter((result) => !result.ok)).toHaveLength(1);
    await expect.poll(async () => (await readRecordingState(popupPage)).phase).toBe('recording');

    const secondShield = await getSnapshotFrame(appPage);
    await clickSnapshotTarget(
      appPage,
      await targetCenter(appPage, 'h1'),
    );
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);

    const steps = await readSteps(popupPage);
    const anchors = steps.filter((step) => step.bounds === null);
    const annotations = steps.filter((step) => step.bounds !== null);
    expect(anchors).toHaveLength(2);
    expect(annotations).toHaveLength(2);
    expect(new Set(anchors.map((anchor) => anchor.id)).size).toBe(2);
    expect(new Set(annotations.map((annotation) => annotation.groupId))).toEqual(
      new Set(anchors.map((anchor) => anchor.id)),
    );

    const editorOpened = extensionContext.waitForEvent('page');
    await clickShieldClosingControl(secondShield.getByRole('button', { name: '完成', exact: true }));
    const editor = await editorOpened;
    await editor.waitForLoadState('domcontentloaded');
    await expect(editor.getByRole('button', { name: /開啟步驟/ })).toHaveCount(2);
  });

  test('invalidates changed viewports, preserves the old group, and rebuilds onto a new anchor', async ({
    appPage,
    popupPage,
    extensionContext,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot');
    await clickSnapshotTarget(appPage, await targetCenter(appPage, '#plain-text'));
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);

    const originalSteps = await readSteps(popupPage);
    const originalAnchor = originalSteps.find((step) => step.bounds === null)!;
    const currentViewport = await appPage.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    await appPage.setViewportSize({ width: 320, height: Math.max(currentViewport.height - 40, 500) });

    await expect.poll(async () => (await readRecordingState(popupPage)).phase).toBe('invalidated');
    const invalidatedShield = await getSnapshotFrame(appPage);
    await expect(invalidatedShield.getByText('畫面尺寸已改變，需建立新快照才能繼續。')).toBeVisible();
    await expect(invalidatedShield.getByRole('button', { name: '保留並重建' })).toBeVisible();
    await expect(invalidatedShield.getByRole('button', { name: '完成錄製' })).toBeVisible();
    const invalidatedLayout = await invalidatedShield.evaluate(() => {
      const rect = (selector: string) => {
        const bounds = document.querySelector(selector)!.getBoundingClientRect();
        return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom };
      };
      return {
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        toolbar: rect('.ft-toolbar--invalidated'),
        status: rect('.ft-invalidated-status'),
        secondary: rect('.ft-invalidated-actions .ft-secondary'),
        primary: rect('.ft-invalidated-actions .ft-finish'),
      };
    });
    expect(invalidatedLayout.scrollWidth).toBeLessThanOrEqual(invalidatedLayout.viewportWidth);
    expect(invalidatedLayout.toolbar.left).toBeGreaterThanOrEqual(0);
    expect(invalidatedLayout.toolbar.right).toBeLessThanOrEqual(invalidatedLayout.viewportWidth);
    expect(invalidatedLayout.status.bottom).toBeLessThanOrEqual(invalidatedLayout.secondary.top);
    expect(invalidatedLayout.secondary.right).toBeLessThanOrEqual(invalidatedLayout.primary.left);

    await clickSnapshotTarget(appPage, await targetCenter(appPage, '#action-button'));
    await expectSteady(async () => await readSteps(popupPage), originalSteps);

    await clickShieldClosingControl(invalidatedShield.getByRole('button', { name: '保留並重建' }));
    await expect.poll(async () => (await readRecordingState(popupPage)).phase).toBe('recording');
    const rebuiltSteps = await readSteps(popupPage);
    const rebuiltAnchors = rebuiltSteps.filter((step) => step.bounds === null);
    expect(rebuiltAnchors).toHaveLength(2);
    expect(rebuiltSteps).toEqual(expect.arrayContaining(originalSteps));
    expect(rebuiltAnchors.map((step) => step.id)).toContain(originalAnchor.id);

    await clickSnapshotTarget(appPage, await targetCenter(appPage, '#action-button'));
    await expect.poll(async () => (await readRecordingState(popupPage)).itemCount).toBe(1);
    const afterRebuild = await readSteps(popupPage);
    const newestAnchor = afterRebuild.filter((step) => step.bounds === null).at(-1)!;
    const newestAnnotation = afterRebuild.filter((step) => step.bounds !== null).at(-1)!;
    expect(newestAnchor.id).not.toBe(originalAnchor.id);
    expect(newestAnnotation.groupId).toBe(newestAnchor.id);

    const countBeforeScroll = afterRebuild.length;
    await appPage.evaluate(() => window.scrollTo(0, 120));
    await expect.poll(async () => (await readRecordingState(popupPage)).phase).toBe('invalidated');
    expect(await readSteps(popupPage)).toHaveLength(countBeforeScroll);
    const scrolledShield = await getSnapshotFrame(appPage);
    await expect(scrolledShield.getByRole('button', { name: '保留並重建' })).toBeVisible();

    const editorOpened = extensionContext.waitForEvent('page');
    await clickShieldClosingControl(scrolledShield.getByRole('button', { name: '完成錄製' }));
    const editor = await editorOpened;
    await editor.waitForLoadState('domcontentloaded');
    await expect.poll(async () => (await readRecordingState(popupPage)).isRecording).toBe(false);
    // The rebuilt group is the run's newest entry, so that anchor is what the editor is handed.
    expect(new URL(editor.url()).searchParams.get('entryId')).toBe(newestAnchor.id);
  });

  test('reuses committed SVG nodes while relayout moves existing annotations', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot');
    const shield = await getSnapshotFrame(appPage);
    const firstPoint = await targetCenter(appPage, '#plain-text');
    const secondPoint = await targetCenter(appPage, '#action-button');

    await clickSnapshotTarget(appPage, firstPoint);
    const firstTargetGroup = shield.locator('g[data-snapshot-selection-id="1"]', {
      has: shield.locator('.snapshot-annotation__frame'),
    });
    await expect(firstTargetGroup).toHaveCount(1);
    await firstTargetGroup.evaluate((element) => element.setAttribute('data-reconciliation-probe', 'retained'));

    await clickSnapshotTarget(appPage, secondPoint);

    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(2);
    await expect(firstTargetGroup).toHaveAttribute('data-reconciliation-probe', 'retained');
    await stopRecording(popupPage);
  });

  test('keeps a committed frame fully painted when its target touches every viewport edge', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await appPage.evaluate(() => {
      const target = document.createElement('button');
      target.id = 'viewport-edge-target';
      target.type = 'button';
      target.textContent = 'Viewport edge target';
      Object.assign(target.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '2147480000',
        margin: '0',
        padding: '0',
        border: '0',
        borderRadius: '0',
        background: '#ffffff',
      });
      document.body.append(target);
    });

    const point = await targetCenter(appPage, '#viewport-edge-target');
    await startRecording(appPage, popupPage, 'snapshot');
    const shield = await getSnapshotFrame(appPage);
    await clickSnapshotTarget(appPage, point);

    const paintBounds = await shield.locator('.snapshot-annotation__frame').evaluate((element) => {
      const frame = element as SVGRectElement;
      const svg = frame.ownerSVGElement!;
      const viewBox = svg.viewBox.baseVal;
      const strokeWidth = Number(frame.getAttribute('stroke-width'));
      const halfStroke = strokeWidth / 2;
      return {
        viewBox: { x: viewBox.x, y: viewBox.y, width: viewBox.width, height: viewBox.height },
        strokeWidth,
        left: frame.x.baseVal.value - halfStroke,
        top: frame.y.baseVal.value - halfStroke,
        right: frame.x.baseVal.value + frame.width.baseVal.value + halfStroke,
        bottom: frame.y.baseVal.value + frame.height.baseVal.value + halfStroke,
        frameWidth: frame.width.baseVal.value,
        frameHeight: frame.height.baseVal.value,
      };
    });

    expect(paintBounds.strokeWidth).toBeGreaterThan(0);
    expect(paintBounds.frameWidth).toBeGreaterThan(0);
    expect(paintBounds.frameHeight).toBeGreaterThan(0);
    expect(paintBounds.left).toBeGreaterThanOrEqual(paintBounds.viewBox.x);
    expect(paintBounds.top).toBeGreaterThanOrEqual(paintBounds.viewBox.y);
    expect(paintBounds.right).toBeLessThanOrEqual(paintBounds.viewBox.x + paintBounds.viewBox.width);
    expect(paintBounds.bottom).toBeLessThanOrEqual(paintBounds.viewBox.y + paintBounds.viewBox.height);
    expect(paintBounds.left).toBe(paintBounds.viewBox.x);
    expect(paintBounds.top).toBe(paintBounds.viewBox.y);
    expect(paintBounds.right).toBe(paintBounds.viewBox.x + paintBounds.viewBox.width);
    expect(paintBounds.bottom).toBe(paintBounds.viewBox.y + paintBounds.viewBox.height);

    await stopRecording(popupPage);
  });

  test('commits and undoes an annotation with the keyboard only', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot');
    const shield = await getSnapshotFrame(appPage);
    await expect(shield.getByRole('button', { name: '完成', exact: true })).toBeVisible();

    // The shield takes keyboard focus on its own: Tab goes to the first candidate (the enabled action button). No pointer is used.
    await appPage.keyboard.press('Tab');
    await expect(shield.locator('.snapshot-box--preview')).toBeVisible({ timeout: 10_000 });

    await appPage.keyboard.press('Enter');
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(1);
    await expect(shield.locator('.snapshot-annotation__badge-label')).toHaveText('1');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);

    await appPage.keyboard.press('Delete');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);
    await expect(shield.locator('.snapshot-annotation__frame')).toHaveCount(0);

    // The page underneath never received the activation.
    expect(await appPage.evaluate(() => window.fixtureState.actionClicks)).toBe(0);

    await stopRecording(popupPage);
  });

  test('scrolling keys cannot move the frozen page out from under the snapshot', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startRecording(appPage, popupPage, 'snapshot');
    await getSnapshotFrame(appPage);
    // The shield document cannot scroll, so any key the browser still acts on chains its scroll to the frozen page and invalidates the run.
    await appPage.mouse.move(400, 300);

    for (const key of ['ArrowDown', 'ArrowUp', 'PageDown', 'End', 'Home', 'Space']) {
      await appPage.keyboard.press(key);
    }
    await expectSteady(async () => (await readRecordingState(popupPage)).phase, 'recording');

    expect(await appPage.evaluate(() => window.scrollY)).toBe(0);
    const state = await readRecordingState(popupPage);
    expect(state.phase).not.toBe('invalidated');
    expect(state.recoverableError).toBeNull();

    await stopRecording(popupPage);
  });

  test('holds moving elements still so marks line up with the snapshot, and releases them after', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await addMovingTarget(appPage);
    await startRecording(appPage, popupPage, 'snapshot');
    const held = await targetCenter(appPage, '#moving-target');
    await appPage.waitForTimeout(300);
    expect(await targetCenter(appPage, '#moving-target')).toEqual(held);

    await clickSnapshotTarget(appPage, held);
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);
    const steps = await readSteps(popupPage);
    const anchor = steps.find((step) => step.bounds === null)!;
    const mark = steps.find((step) => step.bounds !== null)!;
    expect(await storedScreenshotShowsMovingTarget(popupPage, anchor.id, mark.bounds!)).toBe(true);

    await stopRecording(popupPage);
    await appPage.waitForTimeout(100);
    expect(await targetCenter(appPage, '#moving-target')).not.toEqual(held);
  });
});

declare global {
  interface Window {
    fixtureState: { actionClicks: number };
  }
}
