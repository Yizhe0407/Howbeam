import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOLLOW_DEBOUNCE_MS } from '@/lib/recording/run/navigation';
import { makeRecordingState } from '../../setup/recording-state';
import { tab, wiredRun } from './fakes';

const stepsRun = makeRecordingState({
  operation: 'recording', isRecording: true, phase: 'recording', sessionId: 'project-1', tabId: 4, runId: 'run-1',
});
const loaded = { status: 'complete' as const };

afterEach(() => {
  vi.useRealTimers();
});

describe('a navigation in the recorded tab', () => {
  it('re-injects the recorder into the next page of a steps run', async () => {
    const run = await wiredRun(stepsRun);
    await run.navigation.handleTabUpdated(4, loaded, tab());
    expect(run.ports.recorder.inject).toHaveBeenCalledWith(4);
    expect(run.state()).toMatchObject({ isRecording: true, error: null });
  });

  it('waits out a browser page and resumes on the next web page', async () => {
    const run = await wiredRun(stepsRun);
    await run.navigation.handleTabUpdated(4, loaded, tab({ url: 'chrome://newtab/' }));
    expect(run.state()).toMatchObject({ isRecording: true, recoverableError: { code: 'RECORDING_WAITING_RESTRICTED_PAGE' } });
    expect(run.ports.recorder.inject).not.toHaveBeenCalled();
    await run.navigation.handleTabUpdated(4, loaded, tab());
    expect(run.state()).toMatchObject({ error: null, recoverableError: null });
    expect(run.ports.recorder.inject).toHaveBeenCalledWith(4);
  });

  it('says site access is missing when the browser hides the URL, and resumes once it is granted', async () => {
    const run = await wiredRun(stepsRun);
    run.ports.permissions.hasAllSites.mockResolvedValue(false);
    await run.navigation.handleTabUpdated(4, loaded, tab({ url: undefined }));
    expect(run.state()).toMatchObject({ recoverableError: { code: 'RECORDING_WAITING_SITE_ACCESS' } });
    run.ports.permissions.hasAllSites.mockResolvedValue(true);
    await run.navigation.resumeAfterSiteAccess();
    expect(run.state()).toMatchObject({ recoverableError: null });
    expect(run.ports.recorder.inject).toHaveBeenCalledWith(4);
  });

  it('ends the run when the recorder cannot run on a recordable page', async () => {
    const run = await wiredRun(stepsRun);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    run.ports.recorder.inject.mockRejectedValue(new Error('Cannot access a chrome-extension:// URL'));
    await run.navigation.handleTabUpdated(4, loaded, tab());
    expect(run.state()).toMatchObject({ isRecording: false, error: 'background.stoppedRecorderUnavailable' });
  });

  it('ends a captured snapshot as soon as its page starts to navigate', async () => {
    const run = await wiredRun({ ...stepsRun, mode: 'snapshot', groupAnchorId: 'a', snapshotViewport: { width: 1, height: 1, scrollX: 0, scrollY: 0 }, snapshotDevicePixelRatio: 1 });
    await run.navigation.handleTabUpdated(4, { status: 'loading' }, tab());
    expect(run.state()).toMatchObject({ isRecording: false, phase: 'error', error: 'background.stoppedSnapshotPageChanged' });
  });
});

describe('following the user', () => {
  it('moves the run into a tab that stays in front, and retires the old recorder', async () => {
    const run = await wiredRun(stepsRun);
    vi.useFakeTimers();
    run.ports.tabs.get.mockResolvedValue(tab({ id: 7 }));
    run.navigation.scheduleFollow(7);
    await vi.advanceTimersByTimeAsync(FOLLOW_DEBOUNCE_MS);
    await run.actor.settled();
    expect(run.state()).toMatchObject({ tabId: 7 });
    expect(run.ports.recorder.inject).toHaveBeenCalledWith(7);
    expect(run.ports.recorder.stop).toHaveBeenCalledWith(4);
  });

  it('stays put without the all-sites grant, or when the tab is a browser page', async () => {
    const run = await wiredRun(stepsRun);
    vi.useFakeTimers();
    run.ports.permissions.hasAllSites.mockResolvedValueOnce(false);
    run.navigation.scheduleFollow(7);
    await vi.advanceTimersByTimeAsync(FOLLOW_DEBOUNCE_MS);
    await run.actor.settled();
    run.ports.tabs.get.mockResolvedValue(tab({ id: 8, url: 'chrome://settings' }));
    run.navigation.scheduleFollow(8);
    await vi.advanceTimersByTimeAsync(FOLLOW_DEBOUNCE_MS);
    await run.actor.settled();
    expect(run.state()).toMatchObject({ tabId: 4 });
  });

  it('carries on in the tab the user is in when the recorded tab closes', async () => {
    const run = await wiredRun(stepsRun);
    run.ports.tabs.activeInFocusedWindow.mockResolvedValue(tab({ id: 9 }));
    run.ports.tabs.get.mockResolvedValue(tab({ id: 9 }));
    await run.lifecycle.recordedTabGone(4);
    expect(run.state()).toMatchObject({ isRecording: true, tabId: 9 });
  });

  it('ends the run when no tab can take it over', async () => {
    const run = await wiredRun(stepsRun);
    run.ports.tabs.activeInFocusedWindow.mockResolvedValue(tab({ id: 9, url: 'chrome://newtab/' }));
    run.ports.tabs.get.mockResolvedValue(tab({ id: 9, url: 'chrome://newtab/' }));
    await run.lifecycle.recordedTabGone(4);
    expect(run.state()).toMatchObject({ isRecording: false, recoverableError: { code: 'RECORDED_TAB_CLOSED' } });
  });
});

