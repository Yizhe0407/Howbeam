import { describe, expect, it, vi } from 'vitest';
import { makeRecordingState } from '../../setup/recording-state';
import { PAGE_URL, wiredRun } from './fakes';

const viewport = { width: 800, height: 600, scrollX: 0, scrollY: 0 };
const context = { viewport: { ...viewport, scrollY: 120 }, devicePixelRatio: 1, url: PAGE_URL, timestamp: 9 };
const snapshotRun = makeRecordingState({
  operation: 'recording', isRecording: true, phase: 'recording', sessionId: 'project-1', tabId: 4, runId: 'run-1',
  mode: 'snapshot', itemCount: 2, runItemCount: 5, groupAnchorId: 'anchor-1', snapshotViewport: viewport, snapshotDevicePixelRatio: 1,
});

describe('snapshot controls', () => {
  it('ends the current snapshot and shows the preparation controls', async () => {
    const run = await wiredRun(snapshotRun);
    await expect(run.snapshot.prepareNext('run-1')).resolves.toEqual({ ok: true });
    expect(run.state()).toMatchObject({ phase: 'preparing-next', itemCount: 0, runItemCount: 5, groupAnchorId: null });
    expect(run.ports.steps.discardPendingAnchor).toHaveBeenCalledWith('anchor-1');
    expect(run.ports.recorder.inject).toHaveBeenCalledWith(4);
  });

  it('captures the next snapshot on the page as it is', async () => {
    const run = await wiredRun({ ...snapshotRun, phase: 'preparing-next', groupAnchorId: null, snapshotViewport: null, snapshotDevicePixelRatio: null, itemCount: 0 });
    run.recorderReports(context);
    await expect(run.snapshot.createNext('run-1', 'preparing-next')).resolves.toEqual({ ok: true });
    expect(run.state()).toMatchObject({ phase: 'recording', groupAnchorId: expect.any(String), snapshotViewport: context.viewport });
    expect(run.steps).toEqual([expect.objectContaining({ groupId: expect.any(String), bounds: null, url: PAGE_URL })]);
    expect(run.ports.tabs.send).toHaveBeenCalledWith(4, { type: 'HOWBEAM_SNAPSHOT_ACTIVE', runId: 'run-1' });
  });

  it('keeps an invalidated snapshot and its annotations when rebuilding it fails', async () => {
    const run = await wiredRun({ ...snapshotRun, phase: 'invalidated' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    run.recorderReports(context);
    run.ports.tabs.send.mockResolvedValue(false);
    await expect(run.snapshot.createNext('run-1', 'invalidated')).resolves.toEqual({ ok: false, error: 'background.rebuildSnapshotFailed' });
    expect(run.state()).toMatchObject({ phase: 'invalidated', itemCount: 2, groupAnchorId: 'anchor-1', recoverableError: { code: 'REBUILD_SNAPSHOT_FAILED' } });
    // The new base image that could not be activated is withdrawn.
    expect(run.ports.steps.discardPendingAnchor).toHaveBeenCalled();
  });

  it('switches a steps run to snapshot preparation, and back to steps', async () => {
    const run = await wiredRun({ ...snapshotRun, mode: 'steps', groupAnchorId: null, snapshotViewport: null, snapshotDevicePixelRatio: null });
    await expect(run.snapshot.switchToSnapshot('run-1')).resolves.toEqual({ ok: true });
    expect(run.state()).toMatchObject({ mode: 'snapshot', phase: 'preparing-next', itemCount: 0, runItemCount: 5 });
    run.recorderReports();
    await expect(run.snapshot.switchToSteps('run-1')).resolves.toEqual({ ok: true });
    expect(run.state()).toMatchObject({ mode: 'steps', phase: 'recording' });
  });

  it('puts a steps run back when the snapshot recorder cannot be injected', async () => {
    const run = await wiredRun({ ...snapshotRun, mode: 'steps', phase: 'paused', groupAnchorId: null, snapshotViewport: null, snapshotDevicePixelRatio: null });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    run.ports.recorder.inject.mockRejectedValueOnce(new Error('no'));
    await expect(run.snapshot.switchToSnapshot('run-1')).resolves.toEqual({ ok: false, error: 'background.switchToSnapshotFailed' });
    expect(run.state()).toMatchObject({ mode: 'steps', phase: 'paused', itemCount: 2 });
  });

  it('falls back to snapshot preparation when the step recorder never reports ready', async () => {
    const run = await wiredRun(snapshotRun);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(run.snapshot.switchToSteps('run-1')).resolves.toEqual({ ok: false, error: 'background.switchToStepsFailed' });
    expect(run.state()).toMatchObject({ mode: 'snapshot', phase: 'preparing-next', recoverableError: { code: 'SWITCH_TO_STEPS_FAILED' } });
  });

  it('refuses controls that do not fit the run', async () => {
    const run = await wiredRun(snapshotRun);
    await expect(run.snapshot.createNext('run-1', 'preparing-next')).resolves.toEqual({ ok: false, error: 'background.cannotCreateNextSnapshot' });
    await expect(run.snapshot.switchToSnapshot('run-1')).resolves.toEqual({ ok: false, error: 'background.cannotSwitchToSnapshot' });
  });
});
