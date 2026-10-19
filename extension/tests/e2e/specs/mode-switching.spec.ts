import { test, expect } from '../support/fixture';
import {
  clickTarget,
  expectStepCount,
  readRecordingState,
  resetExtensionData,
  sendRecordingControl,
  startStepsRunWithFirstStep,
  stopRecording,
} from '../support/harness';

test.describe('switching recording modes mid-run', () => {
  test.beforeEach(async ({ popupPage }) => {
    await resetExtensionData(popupPage);
  });

  test('moves a steps run into snapshot preparation and back without losing captured steps', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startStepsRunWithFirstStep(appPage, popupPage);

    expect(await sendRecordingControl(popupPage, 'SWITCH_TO_SNAPSHOT_MODE')).toEqual({ ok: true });
    await expect.poll(async () => (await readRecordingState(popupPage)).phase).toBe('preparing-next');
    expect(await readRecordingState(popupPage)).toMatchObject({ mode: 'snapshot', itemCount: 0, groupAnchorId: null });
    await expect.poll(() => appPage.locator('[data-howbeam-step-preview]').count()).toBe(0);

    expect(await sendRecordingControl(popupPage, 'SWITCH_TO_STEPS_MODE')).toEqual({ ok: true });
    await expect.poll(async () => (await readRecordingState(popupPage)).phase).toBe('recording');
    expect(await readRecordingState(popupPage)).toMatchObject({ mode: 'steps', itemCount: 0 });
    await expect.poll(() => appPage.locator('[data-howbeam-step-preview]').count()).toBe(1);

    await clickTarget(appPage, '#plain-text');
    await expectStepCount(popupPage, 2);
    await stopRecording(popupPage);
  });

  test('rejects a mode switch the run is not in a position to make', async ({
    appPage,
    popupPage,
    browserErrors: _browserErrors,
  }) => {
    await startStepsRunWithFirstStep(appPage, popupPage);

    expect(await sendRecordingControl(popupPage, 'SWITCH_TO_STEPS_MODE')).toMatchObject({ ok: false });
    expect(await readRecordingState(popupPage)).toMatchObject({ mode: 'steps', phase: 'recording' });
    await stopRecording(popupPage);
  });
});
