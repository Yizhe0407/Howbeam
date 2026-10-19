import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from '../support/fixture';
import {
  clickTarget,
  expectStepCount,
  resetExtensionData,
  seedAndSelectProject,
  sendRecordingControl,
  startRecording,
  startStepsRunWithFirstStep,
} from '../support/harness';

/** The product keeps exactly one editor tab, so these assertions check what a user can see: how many editor pages exist and which Project it shows. */
function extensionPages(context: BrowserContext, page: 'editor' | 'library'): Page[] {
  return context.pages().filter((candidate) => new URL(candidate.url()).pathname === `/${page}.html`);
}

function viewedSessionId(editor: Page): string | null {
  return new URL(editor.url()).searchParams.get('sessionId');
}

test.describe('single editor tab', () => {
  test.beforeEach(async ({ popupPage }) => {
    await resetExtensionData(popupPage);
  });

  test('reuses the open editor when the library opens a different Project', async ({
    appPage,
    popupPage,
    extensionContext,
    extensionId,
    browserErrors: _browserErrors,
  }) => {
    // The seeded Project gets one captured step, so the two Projects are told apart by what the editor renders and not only by its URL.
    await startStepsRunWithFirstStep(appPage, popupPage);
    const editorOpened = extensionContext.waitForEvent('page');
    await sendRecordingControl(popupPage, 'FINISH_RECORDING');

    const firstEditor = await editorOpened;
    await firstEditor.waitForLoadState('domcontentloaded');
    const recordedProjectId = viewedSessionId(firstEditor);
    expect(recordedProjectId).toBeTruthy();
    await expect(firstEditor.getByText('步驟 · 1', { exact: true })).toBeVisible();

    const library = await extensionContext.newPage();
    await library.goto(`chrome-extension://${extensionId}/library.html`);
    // 新增 creates an empty Project and must open it in the already-open editor tab, not a third tab; the toolbar control shares its name with the add-card tile, so it's `.first()`.
    await library.getByRole('button', { name: '新增', exact: true }).first().click();

    await expect.poll(() => viewedSessionId(firstEditor)).not.toBe(recordedProjectId);
    const newProjectId = viewedSessionId(firstEditor);
    await expect(firstEditor.getByText('尚未建立內容', { exact: true })).toBeVisible();
    expect(extensionPages(extensionContext, 'editor')).toHaveLength(1);

    // Back the other way: the recorded Project's card must reuse the same tab.
    await library.bringToFront();
    const recordedCard = library.getByRole('listitem').filter({ hasText: '1 個畫面' });
    await expect(recordedCard).toHaveCount(1);
    await recordedCard.getByRole('button', { name: '開啟', exact: true }).click();

    await expect.poll(() => viewedSessionId(firstEditor)).toBe(recordedProjectId);
    expect(newProjectId).not.toBe(recordedProjectId);
    await expect(firstEditor.getByText('步驟 · 1', { exact: true })).toBeVisible();
    expect(extensionPages(extensionContext, 'editor')).toHaveLength(1);

    // Page-to-page navigation stays in the tab: going back to the library from
    // the editor turns that very tab into the library, adding no tab.
    await firstEditor.bringToFront();
    const pagesBefore = extensionContext.pages().length;
    await firstEditor.getByRole('button', { name: 'Howbeam 專案庫' }).click();
    await firstEditor.waitForURL(/\/library\.html$/);
    expect(extensionPages(extensionContext, 'editor')).toHaveLength(0);
    expect(extensionContext.pages()).toHaveLength(pagesBefore);
  });

  test('turns the library into the editor when no editor is open', async ({
    popupPage,
    extensionContext,
    extensionId,
    browserErrors: _browserErrors,
  }) => {
    const library = await extensionContext.newPage();
    await library.goto(`chrome-extension://${extensionId}/library.html`);
    const pagesBefore = extensionContext.pages().length;

    await library.getByRole('button', { name: '新增', exact: true }).first().click();

    await library.waitForURL(/\/editor\.html\?sessionId=/);
    await expect(library.getByText('尚未建立內容', { exact: true })).toBeVisible();
    expect(extensionContext.pages()).toHaveLength(pagesBefore);

    // The tab is now remembered as the editor, not the library: the popup's
    // 專案庫 has to open a library tab of its own rather than focus this one.
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
    // The real popup closes itself after opening a page; keep this tab-hosted one.
    await popupPage.evaluate(() => {
      window.close = () => {};
    });
    const libraryOpened = extensionContext.waitForEvent('page');
    await popupPage.getByRole('button', { name: '專案庫', exact: true }).click();
    const reopened = await libraryOpened;
    await reopened.waitForURL(/\/library\.html$/);
    expect(new URL(library.url()).pathname).toBe('/editor.html');
  });

  test('finishing two recordings in a row leaves one editor tab', async ({
    appPage,
    popupPage,
    extensionContext,
    browserErrors: _browserErrors,
  }) => {
    await startStepsRunWithFirstStep(appPage, popupPage);
    const editorOpened = extensionContext.waitForEvent('page');
    const firstFinish = await sendRecordingControl(popupPage, 'FINISH_RECORDING');
    expect(firstFinish.ok).toBe(true);

    const editor = await editorOpened;
    await editor.waitForLoadState('domcontentloaded');
    const firstProjectId = viewedSessionId(editor);
    expect(firstProjectId).toBeTruthy();

    // A second run records into another Project, exactly as a popup start does; that mismatch is what used to spawn a new tab on every 完成.
    const secondProjectId = await seedAndSelectProject(popupPage, '第二份錄製');
    expect(secondProjectId).not.toBe(firstProjectId);
    await startRecording(appPage, popupPage, 'steps');
    await clickTarget(appPage, '#plain-text');
    // Step counts are read across the whole store, so the second run's capture has to be awaited as the second row overall.
    await expectStepCount(popupPage, 2);
    const secondFinish = await sendRecordingControl(popupPage, 'FINISH_RECORDING');
    expect(secondFinish.ok).toBe(true);

    await expect.poll(() => viewedSessionId(editor)).toBe(secondProjectId);
    // Finishing hands the editor the run's last capture, as before.
    await expect.poll(() => new URL(editor.url()).searchParams.get('entryId')).not.toBeNull();
    expect(extensionPages(extensionContext, 'editor')).toHaveLength(1);
  });
});
