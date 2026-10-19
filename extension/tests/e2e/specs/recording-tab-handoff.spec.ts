import { test, expect, FIXTURE_URL } from '../support/fixture';
import {
  clickTarget,
  readRecordingState,
  readSteps,
  resetExtensionData,
  startStepsRunWithFirstStep,
  stopRecording,
} from '../support/harness';

// The E2E build grants <all_urls>, so follow mode is armed for steps runs.
test.describe('recording across tabs and unrecordable pages', () => {
  test.beforeEach(async ({ popupPage }) => {
    await resetExtensionData(popupPage);
  });

  test('closing a tab the run followed into hands the run back instead of ending it', async ({
    appPage,
    popupPage,
    extensionContext,
    browserErrors: _browserErrors,
  }) => {
    await startStepsRunWithFirstStep(appPage, popupPage);
    const firstTabId = (await readRecordingState(popupPage)).tabId as number;

    const secondPage = await extensionContext.newPage();
    await secondPage.goto(`${FIXTURE_URL}navigated.html`);
    await appPage.bringToFront();
    await secondPage.bringToFront();
    await expect.poll(async () => (await readRecordingState(popupPage)).tabId).not.toBe(firstTabId);

    await secondPage.close();
    await appPage.bringToFront();

    await expect.poll(async () => (await readRecordingState(popupPage)).tabId).toBe(firstTabId);
    const state = await readRecordingState(popupPage);
    expect(state).toMatchObject({ isRecording: true, phase: 'recording' });
    expect((state.recoverableError as { code?: string } | null)?.code).not.toBe('RECORDED_TAB_CLOSED');
    await expect.poll(() => appPage.locator('[data-howbeam-step-preview]').count()).toBe(1);
    await clickTarget(appPage, '#action-button span');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);

    await stopRecording(popupPage);
  });

  test('follows a blank tab once the user loads a page in it', async ({
    appPage,
    popupPage,
    extensionContext,
    browserErrors: _browserErrors,
  }) => {
    await startStepsRunWithFirstStep(appPage, popupPage);
    const firstTabId = (await readRecordingState(popupPage)).tabId as number;

    // Ctrl+T: the blank tab is activated while it still cannot be recorded.
    const blankPage = await extensionContext.newPage();
    await blankPage.bringToFront();
    await blankPage.waitForTimeout(500);
    expect((await readRecordingState(popupPage)).tabId).toBe(firstTabId);

    // The user types a URL there.
    await blankPage.goto(`${FIXTURE_URL}navigated.html`);
    await expect.poll(async () => (await readRecordingState(popupPage)).tabId).not.toBe(firstTabId);
    await expect.poll(() => blankPage.locator('[data-howbeam-step-preview]').count()).toBe(1);
    await clickTarget(blankPage, 'h1');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);

    await stopRecording(popupPage);
    await blankPage.close();
  });

  test('a steps run waits on a browser page and resumes when the tab returns to the site', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startStepsRunWithFirstStep(appPage, popupPage);
    const tabId = (await readRecordingState(popupPage)).tabId as number;

    await appPage.goto('chrome://version/');
    await expect.poll(async () =>
      ((await readRecordingState(popupPage)).recoverableError as { code?: string } | null)?.code,
    ).toBe('RECORDING_WAITING_RESTRICTED_PAGE');
    expect(await readRecordingState(popupPage)).toMatchObject({ isRecording: true, tabId });

    await appPage.goto(`${FIXTURE_URL}navigated.html`);
    await expect.poll(async () => (await readRecordingState(popupPage)).recoverableError).toBeNull();
    await expect.poll(() => appPage.locator('[data-howbeam-step-preview]').count()).toBe(1);
    await clickTarget(appPage, 'h1');
    await expect.poll(async () => (await readSteps(popupPage)).length).toBe(2);

    await stopRecording(popupPage);
  });
});
