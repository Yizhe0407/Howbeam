import { describe, expect, it, vi } from 'vitest';
import type { ClickCapture } from '@/lib/runtime/messages';
import { makeRecordingState } from '../../setup/recording-state';
import { PAGE_URL, tab, wiredRun } from './fakes';

const sender = { frameId: 0, url: PAGE_URL, tab: tab({ id: 4, windowId: 1 }) };
const viewport = { width: 800, height: 600, scrollX: 0, scrollY: 0 };
const stepsRun = makeRecordingState({
  operation: 'recording', isRecording: true, phase: 'recording', sessionId: 'project-1', tabId: 4, runId: 'run-1',
});
const snapshotRun = makeRecordingState({
  ...stepsRun, mode: 'snapshot', groupAnchorId: 'anchor-1', snapshotViewport: viewport, snapshotDevicePixelRatio: 1,
});

function click(overrides: Partial<ClickCapture> = {}): ClickCapture {
  return {
    type: 'HOWBEAM_CLICK', captureId: `c-${Math.random()}`, runId: 'run-1', rect: { x: 1, y: 2, width: 30, height: 20 },
    devicePixelRatio: 1, viewport, text: '設定', tagName: 'button', intent: 'click', url: PAGE_URL, timestamp: 5,
    ...overrides,
  };
}

describe('a click in a steps run', () => {
  it('takes the screenshot, lets the page replay the click, stores the step and counts it', async () => {
    const run = await wiredRun(stepsRun);
    const message = click();
    await expect(run.capture.handleClick(message, sender)).resolves.toEqual({ ok: true });
    expect(run.ports.tabs.send).toHaveBeenCalledWith(4, { type: 'HOWBEAM_CAPTURE_TAKEN', runId: 'run-1', captureId: message.captureId });
    expect(run.steps).toEqual([expect.objectContaining({ sessionId: 'project-1', runId: 'run-1', bounds: message.rect, description: expect.any(String) })]);
    expect(run.state()).toMatchObject({ itemCount: 1, runItemCount: 1, lastCommittedCaptureId: message.captureId });
  });

  it.each([
    ['another tab is in front', tab({ id: 9 }), 'background.stepSkippedInactiveTab'],
    ['the page changed', tab({ url: 'https://site.example/other' }), 'background.stepSkippedPageChanged'],
  ])('tells the user when %s, and keeps recording', async (_name, active, copy) => {
    const run = await wiredRun(stepsRun);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    run.ports.tabs.activeInWindow.mockResolvedValue(active);
    await expect(run.capture.handleClick(click(), sender)).resolves.toMatchObject({ ok: false, reported: true });
    expect(run.state()).toMatchObject({ isRecording: true, error: copy, recoverableError: { code: 'CAPTURE_FAILED' } });
    expect(run.steps).toEqual([]);
  });

  it('turns down clicks from another tab, another run, or a paused run', async () => {
    const run = await wiredRun(stepsRun);
    await expect(run.capture.handleClick(click(), { ...sender, tab: tab({ id: 5 }) })).resolves.toMatchObject({ ok: false, error: 'untrusted-sender' });
    await expect(run.capture.handleClick(click({ runId: 'run-0' }), sender)).resolves.toMatchObject({ ok: false, error: 'not-recording' });
    await run.lifecycle.pause('run-1');
    await expect(run.capture.handleClick(click(), sender)).resolves.toMatchObject({ ok: false, error: 'wrong-phase' });
  });

  it('drops a capture the page cancelled before it was stored', async () => {
    const run = await wiredRun(stepsRun);
    const message = click();
    run.ports.capture.mockImplementationOnce(async (_request, guard) => {
      await run.capture.handleCancelCapture({ type: 'HOWBEAM_CANCEL_CAPTURE', runId: 'run-1', captureId: message.captureId }, sender);
      await guard();
      return { blob: new Blob(['x']), scale: 1 };
    });
    await expect(run.capture.handleClick(message, sender)).resolves.toMatchObject({ ok: false });
    expect(run.steps).toEqual([]);
    expect(run.state()).toMatchObject({ itemCount: 0, error: null });
  });
});

describe('a click in a snapshot run', () => {
  async function withAnchor(state = snapshotRun) {
    const run = await wiredRun(state);
    run.steps.push({ id: 'anchor-1', sessionId: 'project-1', runId: 'run-1', order: 0, bounds: null, devicePixelRatio: 1, screenshotScale: 2, screenshotBlob: new Blob(['a']), description: '', url: PAGE_URL, timestamp: 1, groupId: 'anchor-1' });
    return run;
  }

  it('stores an annotation on the base image, without a screenshot of its own', async () => {
    const run = await withAnchor();
    await expect(run.capture.handleClick(click({ intent: 'mark' }), sender)).resolves.toEqual({ ok: true });
    expect(run.ports.capture).not.toHaveBeenCalled();
    expect(run.steps.at(-1)).toMatchObject({ groupId: 'anchor-1', screenshotScale: 2, description: '' });
    expect(run.state()).toMatchObject({ itemCount: 1 });
  });

  it('invalidates the snapshot when the viewport no longer matches', async () => {
    const run = await withAnchor();
    await expect(run.capture.handleClick(click({ viewport: { ...viewport, scrollY: 300 } }), sender))
      .resolves.toMatchObject({ ok: false, reported: true, error: 'snapshot-viewport-changed' });
    expect(run.state()).toMatchObject({ phase: 'invalidated', recoverableError: { code: 'SNAPSHOT_VIEWPORT_CHANGED' } });
  });

  it('ends the run once when the base image is gone', async () => {
    const run = await wiredRun(snapshotRun);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(run.capture.handleClick(click(), sender)).resolves.toMatchObject({ reported: true, error: 'snapshot-anchor-missing' });
    expect(run.state()).toMatchObject({ isRecording: false, phase: 'error', recoverableError: { code: 'SNAPSHOT_ANCHOR_MISSING' } });
  });
});

describe('the recorder reporting in', () => {
  it('keeps a recorder re-injected into a live run, and turns away anything else', async () => {
    const run = await wiredRun(stepsRun);
    await expect(run.capture.handleRecorderReady({ type: 'HOWBEAM_READY', runId: 'run-1' }, sender)).resolves.toBe(true);
    await expect(run.capture.handleRecorderReady({ type: 'HOWBEAM_READY', runId: 'run-0' }, sender)).resolves.toBe(false);
    await expect(run.capture.handleRecorderReady({ type: 'HOWBEAM_READY', runId: 'run-1' }, { ...sender, frameId: 3 })).resolves.toBe(false);
  });

  it('ends a snapshot run whose shield broke', async () => {
    const run = await wiredRun(snapshotRun);
    await expect(run.capture.handleSnapshotRecorderFailure({ type: 'SNAPSHOT_RECORDER_FAILED', runId: 'run-1', reason: 'shield-channel' }, sender)).resolves.toBe(true);
    expect(run.state()).toMatchObject({ phase: 'error', recoverableError: { code: 'SNAPSHOT_SHIELD_FAILED' } });
  });
});

describe('undo and restore', () => {
  it('removes the last capture, and puts it back with the token', async () => {
    const run = await wiredRun(stepsRun);
    await run.capture.handleClick(click(), sender);
    const undone = await run.undo.undo('run-1');
    expect(undone).toEqual({ ok: true, undoToken: expect.any(String), removedItemNumber: 1 });
    expect(run.steps).toEqual([]);
    expect(run.state()).toMatchObject({ itemCount: 0 });
    await expect(run.undo.restore('run-1', 'wrong')).resolves.toEqual({ ok: false, error: 'background.cannotRestore' });
    // A refused restore closes the window.
    await expect(run.undo.restore('run-1', undone.ok ? undone.undoToken : '')).resolves.toEqual({ ok: false, error: 'background.cannotRestore' });
  });

  it('restores once, and a new click closes the window', async () => {
    const run = await wiredRun(stepsRun);
    await run.capture.handleClick(click(), sender);
    const undone = await run.undo.undo('run-1');
    const token = undone.ok ? undone.undoToken : '';
    await expect(run.undo.restore('run-1', token)).resolves.toEqual({ ok: true });
    expect(run.steps).toHaveLength(1);
    expect(run.state()).toMatchObject({ itemCount: 1 });
    const again = await run.undo.undo('run-1');
    await run.capture.handleClick(click(), sender);
    await expect(run.undo.restore('run-1', again.ok ? again.undoToken : '')).resolves.toMatchObject({ ok: false });
  });

  it('has nothing to undo before the first capture', async () => {
    const run = await wiredRun(stepsRun);
    await expect(run.undo.undo('run-1')).resolves.toEqual({ ok: false, error: 'background.nothingToUndo' });
  });
});
