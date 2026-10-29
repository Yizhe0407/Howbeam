import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { test, expect, FIXTURE_URL } from '../support/fixture';

import {
  clickSnapshotTarget,
  clickTarget,
  readLatestDownload,
  readRecordingState,
  readSteps,
  resetExtensionData,
  startRecording,
  stopRecording,
  targetCenter,
} from '../support/harness';
import { itemAt } from '../../setup/item-at';

declare const chrome: {
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
    };
  };
};

async function recordStepTargets(appPage: Page, popupPage: Page, selectors: string[]): Promise<void> {
  const initialCount = (await readSteps(popupPage)).length;
  await startRecording(appPage, popupPage, 'steps');
  for (const [index, selector] of selectors.entries()) {
    await clickTarget(appPage, selector);
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(initialCount + index + 1);
  }
  await stopRecording(popupPage);
}

async function recordSnapshotTargets(
  appPage: Page,
  popupPage: Page,
  selectors: string[],
): Promise<void> {
  const initialCount = (await readSteps(popupPage)).length;
  await startRecording(appPage, popupPage, 'snapshot');
  await expect.poll(async () => (await readSteps(popupPage)).length).toBe(initialCount + 1);
  for (const [index, selector] of selectors.entries()) {
    await clickSnapshotTarget(appPage, await targetCenter(appPage, selector));
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(initialCount + index + 2);
  }
  await stopRecording(popupPage);
}

async function openEditor(
  extensionContext: BrowserContext,
  extensionId: string,
  popupPage: Page,
  expectedEntries: number,
): Promise<Page> {
  const sessionId = await popupPage.evaluate(async () => {
    const stored = await chrome.storage.local.get('howbeam:activeProjectId');
    return stored['howbeam:activeProjectId'];
  });
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('No active E2E Project was initialized.');
  }
  const editor = await extensionContext.newPage();
  await editor.goto(`chrome-extension://${extensionId}/editor.html?sessionId=${encodeURIComponent(sessionId)}`);
  await expect(editor.getByText(`步驟 · ${expectedEntries}`, { exact: true })).toBeVisible();
  return editor;
}

async function dragBetween(page: Page, source: Locator, target: Locator): Promise<void> {
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error('Drag handle has no bounding box');

  const sourcePoint = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
  const targetPoint = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };
  await page.mouse.move(sourcePoint.x, sourcePoint.y);
  await page.mouse.down();
  await page.mouse.move(sourcePoint.x, sourcePoint.y + 8, { steps: 4 });
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 12 });
  await page.waitForTimeout(100);
  await page.mouse.up();
}

async function readClipboardPng(page: Page): Promise<{
  type: string;
  size: number;
  signature: number[];
  width: number;
  height: number;
}> {
  return page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const item = items.find((candidate) => candidate.types.includes('image/png'));
    if (!item) throw new Error('Clipboard does not contain a PNG image');
    const blob = await item.getType('image/png');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const bitmap = await createImageBitmap(blob);
    const result = {
      type: blob.type,
      size: blob.size,
      signature: Array.from(bytes.slice(0, 8)),
      width: bitmap.width,
      height: bitmap.height,
    };
    bitmap.close();
    return result;
  });
}

/**
 * Copies with `button` and returns the PNG it put on the clipboard. The
 * clipboard is emptied first: otherwise a previous copy's PNG satisfies the
 * wait at once and the read races the new write. The copy button gives no DOM
 * signal when the write finishes, so the clipboard itself is polled.
 */
async function copyAndReadPng(page: Page, button: Locator): ReturnType<typeof readClipboardPng> {
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await button.click();
  let png: Awaited<ReturnType<typeof readClipboardPng>> | undefined;
  await expect.poll(
    async () => {
      try {
        png = await readClipboardPng(page);
        return true;
      } catch {
        return false;
      }
    },
    { timeout: 10_000 },
  ).toBe(true);
  return png!;
}

test.describe('editor workflows', () => {
  test.beforeEach(async ({ popupPage }) => {
    await resetExtensionData(popupPage);
  });

  test('persists step and annotation edits, numbering, and annotation deletion', async ({
    appPage,
    popupPage,
    extensionContext,
    extensionId,
    browserErrors: _browserErrors,
  }) => {
    await recordStepTargets(appPage, popupPage, ['#plain-text']);
    await recordSnapshotTargets(appPage, popupPage, ['#action-button', '#visual-container strong']);
    const editor = await openEditor(extensionContext, extensionId, popupPage, 2);

    const description = editor.getByPlaceholder('輸入步驟說明…');
    await description.fill('更新後的步驟說明');
    await expect.poll(async () => (await readSteps(popupPage))[0]?.description).toBe('更新後的步驟說明');

    await editor.getByRole('button', { name: '開啟步驟 2' }).click();
    await expect(editor.locator('aside').getByText('標註 · 2', { exact: true })).toBeVisible();
    const annotations = editor.getByPlaceholder('輸入標註說明…');
    await annotations.nth(0).fill('更新後的快照標註');
    await expect.poll(async () => (await readSteps(popupPage)).some(
      (step) => step.description === '更新後的快照標註',
    )).toBe(true);

    // Markers are always numbered; there is no switch to turn that off.
    await expect(editor.getByRole('switch')).toHaveCount(0);

    await editor.getByRole('button', { name: '刪除標註 2' }).click();
    await expect(editor.locator('aside').getByText('標註 · 1', { exact: true })).toBeVisible();
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(3);
    expect((await readSteps(popupPage)).filter((step) => step.groupId && step.bounds)).toHaveLength(1);
  });

  test('removes an empty snapshot group and its anchor after deleting its last annotation', async ({
    appPage,
    popupPage,
    extensionContext,
    extensionId,
    browserErrors: _browserErrors,
  }) => {
    await recordSnapshotTargets(appPage, popupPage, ['#action-button']);
    const storedBeforeDelete = await readSteps(popupPage);
    const anchor = storedBeforeDelete.find((step) => step.groupId === step.id && step.bounds === null);
    const annotation = storedBeforeDelete.find((step) => step.groupId === anchor?.id && step.bounds !== null);
    expect(anchor).toBeDefined();
    expect(annotation).toBeDefined();

    const editor = await openEditor(extensionContext, extensionId, popupPage, 1);
    await expect(editor.locator('aside').getByText('標註 · 1', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: '刪除標註 1' }).click();

    await expect(editor.getByText('尚未建立內容', { exact: true })).toBeVisible();
    await expect(editor.getByRole('button', { name: '開啟步驟 1' })).toHaveCount(0);
    await expect.poll(async () => (await readSteps(popupPage)).map((step) => step.id)).toEqual([]);
  });

  test('renders partially overlapping control hit areas as disjoint annotation frames', async ({
    appPage,
    popupPage,
    extensionContext,
    extensionId,
    browserErrors: _browserErrors,
  }) => {
    await recordSnapshotTargets(appPage, popupPage, ['#action-button', '#disabled-button']);
    await popupPage.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('howbeam', 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('steps', 'readwrite');
          const store = tx.objectStore('steps');
          const all = store.getAll();
          all.onerror = () => reject(all.error);
          all.onsuccess = () => {
            const annotations = all.result
              .filter((step) => step.groupId && step.id !== step.groupId)
              .sort((first, second) => first.order - second.order);
            const bounds = [
              { x: 100, y: 80, width: 64, height: 48 },
              { x: 150, y: 80, width: 64, height: 48 },
            ];
            annotations.forEach((step, index) => store.put({ ...step, bounds: bounds[index] }));
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
    });

    const editor = await openEditor(extensionContext, extensionId, popupPage, 1);
    const frames = editor.locator('main [data-howbeam-annotation-frame]');
    await expect(frames).toHaveCount(2);
    const first = await frames.nth(0).boundingBox();
    const second = await frames.nth(1).boundingBox();
    if (!first || !second) throw new Error('Rendered annotation frame has no bounding box');

    expect(first.x + first.width).toBeLessThan(second.x);
    expect(Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y))
      .toBeGreaterThan(0);
  });

  test('reorders timeline entries and annotations through their drag handles', async ({
    appPage,
    popupPage,
    extensionContext,
    extensionId,
    browserErrors: _browserErrors,
  }) => {
    await recordStepTargets(appPage, popupPage, ['#plain-text', '#visual-container strong']);
    await recordSnapshotTargets(appPage, popupPage, ['#action-button', '#disabled-button', '#fixture-canvas']);
    const storedBeforeReorder = await readSteps(popupPage);
    expect(storedBeforeReorder).toHaveLength(6);
    const ordinarySteps = storedBeforeReorder.filter((step) => step.groupId === undefined).sort((a, b) => a.order - b.order);
    const groupedSteps = storedBeforeReorder.filter((step) => step.groupId !== undefined).sort((a, b) => a.order - b.order);
    const snapshotAnchor = groupedSteps.find((step) => step.id === step.groupId);
    const annotations = groupedSteps.filter((step) => step.id !== step.groupId);
    const [firstTimelineStep, secondTimelineStep] = ordinarySteps;
    const [firstAnnotation, secondAnnotation, thirdAnnotation] = annotations;
    if (!firstTimelineStep || !secondTimelineStep || !snapshotAnchor || !firstAnnotation || !secondAnnotation || !thirdAnnotation) {
      throw new Error('Expected two ordinary steps and one three-annotation snapshot group.');
    }
    const snapshotGroupId = snapshotAnchor.id;
    expect(groupedSteps).toHaveLength(4);
    expect(groupedSteps.every((step) => step.groupId === snapshotGroupId)).toBe(true);
    const editor = await openEditor(extensionContext, extensionId, popupPage, 3);

    const railHandles = editor.locator('nav').getByRole('button', { name: '拖曳排序' });
    await expect(railHandles).toHaveCount(3);
    await dragBetween(editor, railHandles.nth(0), railHandles.nth(2));
    await expect.poll(async () => (await readSteps(popupPage)).map(({ id, groupId }) => ({ id, groupId }))).toEqual([
      { id: secondTimelineStep.id, groupId: undefined },
      { id: snapshotAnchor.id, groupId: snapshotGroupId },
      { id: firstAnnotation.id, groupId: snapshotGroupId },
      { id: secondAnnotation.id, groupId: snapshotGroupId },
      { id: thirdAnnotation.id, groupId: snapshotGroupId },
      { id: firstTimelineStep.id, groupId: undefined },
    ]);

    await editor.reload();
    await expect(editor.getByText('步驟 · 3', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: '開啟步驟 2' }).click();
    await expect(editor.locator('aside').getByText('標註 · 3', { exact: true })).toBeVisible();
    const annotationPanel = editor.locator('aside');
    const annotationHandles = annotationPanel.getByRole('button', { name: '拖曳排序' });
    await expect(annotationHandles).toHaveCount(3);
    await dragBetween(editor, annotationHandles.nth(0), annotationHandles.nth(2));
    await expect.poll(async () => (await readSteps(popupPage)).map(({ id, groupId }) => ({ id, groupId }))).toEqual([
      { id: secondTimelineStep.id, groupId: undefined },
      { id: snapshotAnchor.id, groupId: snapshotGroupId },
      { id: secondAnnotation.id, groupId: snapshotGroupId },
      { id: thirdAnnotation.id, groupId: snapshotGroupId },
      { id: firstAnnotation.id, groupId: snapshotGroupId },
      { id: firstTimelineStep.id, groupId: undefined },
    ]);
    await expect(annotationPanel.getByPlaceholder('輸入標註說明…')).toHaveCount(3);
  });

  test('navigates every timeline entry in the lightbox with buttons and arrow keys', async ({
    appPage,
    popupPage,
    extensionContext,
    extensionId,
    browserErrors: _browserErrors,
  }) => {
    await recordStepTargets(appPage, popupPage, ['#plain-text', '#visual-container strong']);
    await recordSnapshotTargets(appPage, popupPage, ['#action-button']);
    const editor = await openEditor(extensionContext, extensionId, popupPage, 3);

    await editor.getByRole('button', { name: '放大圖片' }).click();
    const dialog = editor.getByRole('dialog');
    await expect(dialog.getByAltText('步驟 1 放大')).toBeVisible();
    await expect(dialog.getByText('1/ 3', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '上一張' })).toBeDisabled();

    await editor.keyboard.press('ArrowRight');
    await expect(dialog.getByAltText('步驟 2 放大')).toBeVisible();
    await dialog.getByRole('button', { name: '下一張' }).click();
    await expect(dialog.getByAltText('步驟 3 放大')).toBeVisible();
    await expect(dialog.getByText('3/ 3', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '下一張' })).toBeDisabled();

    await dialog.getByRole('button', { name: '上一張' }).click();
    await expect(dialog.getByAltText('步驟 2 放大')).toBeVisible();
    await editor.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('copies ordinary and snapshot entries as valid PNG images', async ({
    appPage,
    popupPage,
    extensionContext,
    extensionId,
    browserErrors: _browserErrors,
  }) => {
    await recordStepTargets(appPage, popupPage, ['#plain-text']);
    await recordSnapshotTargets(appPage, popupPage, ['#action-button', '#visual-container strong']);
    const editor = await openEditor(extensionContext, extensionId, popupPage, 2);

    const ordinaryPng = await copyAndReadPng(editor, editor.getByRole('button', { name: '複製圖片' }));
    expect(ordinaryPng).toMatchObject({
      type: 'image/png',
      signature: [137, 80, 78, 71, 13, 10, 26, 10],
    });
    expect(ordinaryPng.size).toBeGreaterThan(10_000);
    expect(ordinaryPng.width).toBeGreaterThan(1_000);
    expect(ordinaryPng.height).toBeGreaterThan(600);

    await editor.getByRole('button', { name: '開啟步驟 2' }).click();
    const snapshotPng = await copyAndReadPng(editor, editor.getByRole('button', { name: '複製圖片' }));
    expect(snapshotPng).toMatchObject({
      type: 'image/png',
      signature: [137, 80, 78, 71, 13, 10, 26, 10],
    });
    expect(snapshotPng.size).toBeGreaterThan(10_000);
  });

  test('exports one valid JPEG per timeline entry in the ZIP archive', async ({
    appPage,
    popupPage,
    extensionContext,
    extensionId,
    browserErrors: _browserErrors,
  }) => {
    await recordStepTargets(appPage, popupPage, ['#plain-text', '#visual-container strong']);
    await recordSnapshotTargets(appPage, popupPage, ['#action-button']);
    const editor = await openEditor(extensionContext, extensionId, popupPage, 3);

    await editor.getByRole('button', { name: '匯出', exact: true }).click();
    const publishDialog = editor.getByRole('dialog', { name: '匯出' });
    await expect(publishDialog).toBeVisible();
    await publishDialog.getByRole('radio', { name: '圖片', exact: true }).click();
    const browserDownload = editor.waitForEvent('download');
    await publishDialog.getByRole('button', { name: '下載圖片' }).click();
    const download = await browserDownload;
    const archivePath = await download.path();
    if (!archivePath) throw new Error('Export download has no local path');

    await expect.poll(async () => (await readLatestDownload(popupPage))?.state).toBe('complete');
    const downloadRecord = await readLatestDownload(popupPage);
    expect(downloadRecord?.mime).toBe('application/zip');
    expect(path.extname(download.suggestedFilename())).toBe('.zip');

    const files = unzipSync(new Uint8Array(await readFile(archivePath)));
    expect(Object.keys(files).sort()).toEqual(['01.jpg', '02.jpg', '03.jpg']);
    for (const bytes of Object.values(files)) {
      expect(Array.from(bytes.slice(0, 3))).toEqual([0xff, 0xd8, 0xff]);
      expect(Array.from(bytes.slice(-2))).toEqual([0xff, 0xd9]);
      expect(bytes.byteLength).toBeGreaterThan(5_000);
    }
  });

  test('names sections in a dialog from the seam, the stage and the menu, across Steps and Mark entries', async ({
    appPage,
    popupPage,
    extensionContext,
    extensionId,
    browserErrors: _browserErrors,
  }) => {
    await recordStepTargets(appPage, popupPage, ['#plain-text', '#visual-container strong']);
    await recordSnapshotTargets(appPage, popupPage, ['#action-button', '#plain-text']);
    const editor = await openEditor(extensionContext, extensionId, popupPage, 3);
    const nameField = editor.getByRole('textbox', { name: '章節名稱' });

    // From the stage, on the Mark entry: the dialog takes focus, Enter creates.
    await editor.getByRole('button', { name: '開啟步驟 3' }).click();
    await editor.getByRole('button', { name: '新增章節' }).click();
    await expect(editor.getByRole('dialog', { name: '新增章節' })).toContainText('從第 3 步開始新章節');
    await expect(nameField).toBeFocused();
    await editor.keyboard.type('標註重點');
    await editor.keyboard.press('Enter');
    await expect(editor.getByRole('heading', { name: '標註重點', level: 2 })).toBeVisible();
    await expect(editor.getByRole('dialog')).toHaveCount(0);

    // From the seam between steps 1 and 2: same dialog, Escape leaves nothing behind.
    await editor.getByRole('button', { name: '從第 2 步開始新章節' }).click();
    await expect(nameField).toBeFocused();
    await editor.keyboard.press('Escape');
    await expect(editor.getByRole('dialog')).toHaveCount(0);
    await expect(editor.getByRole('heading', { level: 2 })).toHaveCount(1);

    // Renaming from the heading's menu keeps focus in the field with the old name selected.
    await editor.getByRole('region', { name: '章節：標註重點' }).getByRole('button', { name: '章節操作' }).click();
    await editor.getByRole('button', { name: '重新命名' }).click();
    await expect(nameField).toBeFocused();
    expect(await nameField.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([0, 4]);
    await editor.keyboard.type('畫面重點');
    await editor.keyboard.press('Enter');
    await expect(editor.getByRole('heading', { name: '畫面重點', level: 2 })).toBeVisible();

    // The section starts at a Mark entry; the published document says so and has no placeholder heading.
    await editor.getByRole('button', { name: '匯出', exact: true }).click();
    const publishDialog = editor.getByRole('dialog', { name: '匯出' });
    await publishDialog.getByRole('radio', { name: 'HTML', exact: true }).click();
    const browserDownload = editor.waitForEvent('download');
    await publishDialog.getByRole('button', { name: '下載 HTML 網頁' }).click();
    const htmlPath = await (await browserDownload).path();
    if (!htmlPath) throw new Error('HTML export has no local path');
    const html = await readFile(htmlPath, 'utf8');
    expect(html).toContain('<h2 class="section-heading">畫面重點</h2>');
    expect(html.indexOf('畫面重點')).toBeLessThan(html.indexOf('<span class="step-number">3.</span>'));
    expect(html).not.toContain('（未填寫說明）');
    expect(html).toContain('Made with Howbeam');
  });

  test('keeps the editor usable at 320px and 768px without horizontal overflow', async ({
    appPage,
    popupPage,
    extensionContext,
    extensionId,
    browserErrors: _browserErrors,
  }) => {
    await recordStepTargets(appPage, popupPage, ['#plain-text']);
    await recordSnapshotTargets(appPage, popupPage, ['#action-button', '#disabled-button']);
    const editor = await openEditor(extensionContext, extensionId, popupPage, 2);

    for (const width of [320, 768]) {
      await editor.setViewportSize({ width, height: 700 });
      await expect(editor.getByRole('navigation', { name: '步驟導覽' })).toBeVisible();
      const publishButton = editor.getByRole('button', { name: '匯出', exact: true });
      await expect(publishButton).toBeVisible();
      await publishButton.click();
      const publishDialog = editor.getByRole('dialog', { name: '匯出' });
      await expect(publishDialog).toBeVisible();
      await expect(publishDialog.getByRole('button', { name: '下載 PDF' })).toBeVisible();
      await editor.keyboard.press('Escape');
      await expect(publishDialog).not.toBeVisible();
      const layout = await editor.evaluate(() => {
        const nav = document.querySelector('nav[aria-label="步驟導覽"]')!.getBoundingClientRect();
        return {
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          scrollWidth: document.documentElement.scrollWidth,
          nav: { left: nav.left, right: nav.right, top: nav.top, bottom: nav.bottom },
        };
      });
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
      expect(layout.nav.left).toBeGreaterThanOrEqual(0);
      expect(layout.nav.right).toBeLessThanOrEqual(layout.viewportWidth);
      expect(layout.nav.top).toBeGreaterThanOrEqual(0);
      expect(layout.nav.bottom).toBeLessThanOrEqual(layout.viewportHeight);
    }

    await editor.setViewportSize({ width: 320, height: 700 });
    await editor.getByRole('button', { name: '開啟步驟 2' }).click();
    const annotationPanel = editor.locator('main aside');
    await annotationPanel.scrollIntoViewIfNeeded();
    const panelBox = await annotationPanel.boundingBox();
    if (!panelBox) throw new Error('Annotation panel has no bounding box');
    expect(panelBox.x).toBeGreaterThanOrEqual(0);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(320);
    await expect(annotationPanel.getByLabel('標註 1 說明')).toBeVisible();
  });

  test('continues recording the same project on a different page via 改在其他頁面接續', async ({
    appPage,
    popupPage,
    extensionContext,
    extensionId,
    browserErrors: _browserErrors,
  }) => {
    await recordStepTargets(appPage, popupPage, ['#plain-text']);
    const editor = await openEditor(extensionContext, extensionId, popupPage, 1);

    // The user has since moved on to a completely different page than the project's stored source URL.
    await appPage.goto(`${FIXTURE_URL}navigated.html`);
    await editor.bringToFront();
    const pagesBefore = extensionContext.pages().length;

    await editor.getByRole('button', { name: '接續錄製', exact: true }).click();
    const dialog = editor.getByRole('dialog');
    await expect(dialog).toContainText('接續錄製前需要存取來源網站');
    await expect(dialog).toContainText('新步驟會接在最後。');
    await dialog.getByRole('button', { name: '改在其他頁面接續' }).click();

    // The elsewhere path shows an explicit tab picker; navigated.html differs from the project's last-step URL, so it is preselected.
    const picker = dialog.getByRole('radiogroup', { name: '選擇要接續錄製的分頁' });
    await expect(picker).toBeVisible();
    const preselected = picker.getByRole('radio', { name: /Howbeam Navigated Fixture/ });
    await expect(preselected).toHaveAttribute('aria-checked', 'true');
    // Extension pages (editor, popup) are never offered as recording targets.
    await expect(picker.getByRole('radio')).toHaveCount(1);
    await dialog.getByRole('button', { name: '開始錄製' }).click();

    await expect.poll(async () => (await readRecordingState(popupPage)).isRecording).toBe(true);
    // The elsewhere path records the already-open navigated.html tab; the source-locked default would have reopened the stored index URL.
    expect(extensionContext.pages().length).toBe(pagesBefore);
    await expect.poll(() => appPage.locator('[data-howbeam-step-preview]').count()).toBe(1);
    expect(appPage.url()).toBe(`${FIXTURE_URL}navigated.html`);

    await clickTarget(appPage, 'h1');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);
    await stopRecording(popupPage);

    const steps = await readSteps(popupPage);
    expect(steps).toHaveLength(2);
    expect(itemAt(steps, 1).sessionId).toBe(itemAt(steps, 0).sessionId);
    expect(itemAt(steps, 1).order).toBeGreaterThan(itemAt(steps, 0).order);
  });

  test('undoes direct entry deletion', async ({
    appPage,
    popupPage,
    extensionContext,
    extensionId,
    browserErrors: _browserErrors,
  }) => {
    await recordStepTargets(appPage, popupPage, ['#plain-text']);
    await recordSnapshotTargets(appPage, popupPage, ['#action-button']);
    const editor = await openEditor(extensionContext, extensionId, popupPage, 2);

    await editor.getByRole('button', { name: '開啟步驟 2' }).click();
    await editor.getByRole('button', { name: '刪除步驟', exact: true }).click();
    await expect(editor.getByText('已刪除步驟 2', { exact: true })).toBeVisible();
    await expect(editor.getByText('步驟 · 1', { exact: true })).toBeVisible();
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);

    await editor.getByRole('button', { name: '還原', exact: true }).click();
    await expect(editor.getByText('步驟 · 2', { exact: true })).toBeVisible();
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(3);

    await editor.getByRole('button', { name: '刪除步驟', exact: true }).click();
    await expect(editor.getByText('步驟 · 1', { exact: true })).toBeVisible();
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(1);
  });
});
