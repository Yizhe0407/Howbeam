import { describe, expect, it, vi } from 'vitest';
import { createLifecycle } from '@/lib/recording/run/lifecycle';
import { toRecordingState } from '@/lib/recording/run/state';
import type { StartRecordingMessage } from '@/lib/runtime/messages';
import { makeRecordingState } from '../../setup/recording-state';
import { EXTENSION_ORIGIN, fakeActor, fakePorts, flush, tab } from './fakes';

const START: StartRecordingMessage = {
  type: 'START_RECORDING',
  target: { kind: 'project', projectId: 'project-1' },
  mode: 'steps',
};
const liveRun = makeRecordingState({
  operation: 'recording',
  isRecording: true,
  phase: 'recording',
  sessionId: 'project-1',
  tabId: 4,
  runId: 'run-1',
  itemCount: 1,
  runItemCount: 1,
  newProject: true,
});

function setup(stored = makeRecordingState()) {
  const { ports, steps } = fakePorts();
  const { actor, saved, gate } = fakeActor(stored);
  const deps = {
    actor,
    ports,
    gate,
    extensionOrigin: EXTENSION_ORIGIN,
    captureAnchor: vi.fn(async () => ({
      id: 'anchor-1',
      viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
      devicePixelRatio: 1,
    })),
    discardUndo: vi.fn(),
    isRecaptureStarting: vi.fn(() => false),
    resolveContinuationTab: vi.fn(async () => ({ ok: true as const, tab: tab({ id: 9 }) })),
    continueAfterTabClosed: vi.fn(async () => 'nowhere' as const),
  };
  const lifecycle = createLifecycle(deps);
  /** The recorder injected for a start reports ready, as the content script would. */
  ports.recorder.inject.mockImplementation(async (tabId: number) => {
    queueMicrotask(() => {
      const op = actor.state().operation;
      if (op.kind === 'recording')
        gate.signal(op.runId, tabId, ports.recorder.inject.mock.calls.length ? readyReport.current : {});
    });
  });
  const readyReport: { current: Record<string, unknown> } = { current: {} };
  return {
    lifecycle,
    ports,
    steps,
    actor,
    saved,
    gate,
    deps,
    readyReport,
    state: () => toRecordingState(actor.state()),
  };
}

describe('starting a recording', () => {
  it('injects the recorder, waits for it, and goes live', async () => {
    const { lifecycle, ports, state } = setup();
    await expect(lifecycle.startRecording(START, {})).resolves.toEqual({
      ok: true,
      sessionId: 'project-1',
      runId: 'id-1',
    });
    expect(ports.recorder.inject).toHaveBeenCalledWith(4);
    expect(state()).toMatchObject({
      operation: 'recording',
      phase: 'recording',
      runId: 'id-1',
      tabId: 4,
      targetProjectTitle: '教學',
    });
  });

  it('captures the base image before a snapshot run goes live', async () => {
    const { lifecycle, deps, state, readyReport } = setup();
    readyReport.current = {
      snapshotContext: {
        viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
        devicePixelRatio: 1,
        url: 'https://site.example/page',
        timestamp: 1,
      },
    };
    await lifecycle.startRecording({ ...START, mode: 'snapshot' }, {});
    expect(deps.captureAnchor).toHaveBeenCalledOnce();
    expect(state()).toMatchObject({ phase: 'recording', groupAnchorId: 'anchor-1', snapshotDevicePixelRatio: 1 });
  });

  it('records into a Project of its own without creating it yet', async () => {
    const { lifecycle, ports, state } = setup();
    await expect(
      lifecycle.startRecording({ type: 'START_RECORDING', target: { kind: 'new' }, mode: 'steps' }, {}),
    ).resolves.toEqual({ ok: true, sessionId: 'id-1', runId: 'id-2' });
    expect(state()).toMatchObject({ sessionId: 'id-1', newProject: true, targetProjectTitle: null });
    expect(ports.projects.ensure).not.toHaveBeenCalled();
    expect(ports.pendingStart.discard).toHaveBeenCalled();
  });

  it('refuses while another operation runs, or for a Project that is gone', async () => {
    const busy = setup(liveRun);
    await expect(busy.lifecycle.startRecording(START, {})).resolves.toEqual({
      ok: false,
      error: 'recaptureFlow.activeOperation',
    });
    const missing = setup();
    missing.ports.projects.get.mockResolvedValue(undefined);
    await expect(missing.lifecycle.startRecording(START, {})).resolves.toEqual({
      ok: false,
      error: 'background.recordTargetMissing',
    });
  });

  it.each([
    ['no tab', undefined, 'NO_ACTIVE_TAB', 'background.noActiveTab'],
    ['a browser page', { url: 'chrome://settings' }, 'RESTRICTED_PAGE', 'background.restrictedBrowserPage'],
  ])('records why it cannot start on %s', async (_name, active, code, copy) => {
    const { lifecycle, ports, state } = setup();
    ports.tabs.activeInCurrentWindow.mockResolvedValue(active ? tab(active) : undefined);
    await expect(lifecycle.startRecording(START, {})).resolves.toEqual({ ok: false, error: copy });
    expect(state()).toMatchObject({ phase: 'error', recoverableError: { code, copy } });
    expect(ports.recorder.inject).not.toHaveBeenCalled();
  });

  it('ends the run when the recorder never reports ready', async () => {
    const { lifecycle, ports, state } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ports.recorder.inject.mockResolvedValue(undefined);
    await expect(lifecycle.startRecording(START, {})).resolves.toEqual({ ok: false, error: 'background.injectFailed' });
    expect(state()).toMatchObject({ isRecording: false, phase: 'error', error: 'background.injectFailed' });
    expect(ports.recorder.stop).toHaveBeenCalledWith(4);
  });

  it('records a continuation in its source tab and after the chosen entry', async () => {
    const { lifecycle, ports, state, deps } = setup();
    ports.projects.continuationAnchor.mockResolvedValue({ afterStepId: 'step-7' });
    await lifecycle.startRecording({ ...START, continuation: {}, insertAfterEntryId: 'entry-7' }, {});
    expect(deps.resolveContinuationTab).toHaveBeenCalled();
    expect(ports.tabs.focus).toHaveBeenCalledWith(9, 1);
    expect(state()).toMatchObject({ tabId: 9, insertAfterStepId: 'step-7' });
  });

  it('gives way to a STOP that arrives while it waits for the recorder', async () => {
    const { lifecycle, ports, state } = setup();
    ports.recorder.inject.mockResolvedValue(undefined);
    const starting = lifecycle.startRecording(START, {});
    await flush();
    expect(state()).toMatchObject({ phase: 'starting' });
    await lifecycle.stopRecording();
    await expect(starting).resolves.toMatchObject({ ok: false });
    expect(state()).toMatchObject({ isRecording: false, phase: 'idle' });
  });
});

describe('controls of a live run', () => {
  it('pauses and resumes a steps run only', async () => {
    const { lifecycle, state } = setup(liveRun);
    await expect(lifecycle.resume('run-1')).resolves.toEqual({ ok: false, error: 'background.cannotResume' });
    await expect(lifecycle.pause('run-1')).resolves.toEqual({ ok: true });
    expect(state()).toMatchObject({ phase: 'paused' });
    await expect(lifecycle.resume('run-1')).resolves.toEqual({ ok: true });
    await expect(lifecycle.pause('run-0')).resolves.toEqual({ ok: false, error: 'background.cannotPause' });
  });

  it("finishes at the run's last entry and opens the editor there", async () => {
    const { lifecycle, ports, steps, state } = setup(liveRun);
    steps.push({
      id: 's1',
      sessionId: 'project-1',
      runId: 'run-1',
      order: 0,
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      devicePixelRatio: 1,
      description: '',
      url: 'https://site.example/',
      timestamp: 1,
    });
    await expect(lifecycle.finish('run-1')).resolves.toEqual({
      ok: true,
      finish: { sessionId: 'project-1', entryId: 's1', itemCount: 1 },
    });
    expect(state()).toMatchObject({ isRecording: false, phase: 'idle', sessionId: 'project-1', error: null });
    expect(ports.recorder.stop).toHaveBeenCalledWith(4);
    expect(ports.editor.open).toHaveBeenCalledWith({ sessionId: 'project-1', entryId: 's1' });
    // The editor opens the run's own Project even when nothing was captured, so it is created here at the latest.
    expect(ports.projects.ensure).toHaveBeenCalledWith('project-1');
  });

  it('offers editor recovery when the editor cannot open after a finish', async () => {
    const { lifecycle, ports, state } = setup(liveRun);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ports.editor.open.mockRejectedValue(new Error('no'));
    await expect(lifecycle.finish('run-1')).resolves.toMatchObject({ ok: true });
    expect(state()).toMatchObject({ phase: 'error', recoverableError: { code: 'EDITOR_OPEN_FAILED' } });
  });

  it('discards a run together with the Project of its own', async () => {
    const { lifecycle, ports, state } = setup(liveRun);
    await expect(lifecycle.discard('run-1')).resolves.toEqual({ ok: true });
    expect(ports.projects.delete).toHaveBeenCalledWith('project-1');
    expect(ports.steps.deleteForRun).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ isRecording: false, phase: 'idle' });
  });

  it("discards only the run's steps from an existing Project", async () => {
    const { lifecycle, ports } = setup({ ...liveRun, newProject: false });
    await expect(lifecycle.discard('run-1')).resolves.toEqual({ ok: true });
    expect(ports.steps.deleteForRun).toHaveBeenCalledWith('project-1', 'run-1');
    expect(ports.projects.delete).not.toHaveBeenCalled();
  });

  it('keeps the run with a notice when its steps cannot be deleted', async () => {
    const { lifecycle, ports, state } = setup({ ...liveRun, newProject: false });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    ports.steps.deleteForRun.mockRejectedValue(new Error('idb'));
    await expect(lifecycle.discard('run-1')).resolves.toEqual({ ok: false, error: 'background.discardFailed' });
    expect(state()).toMatchObject({ isRecording: true, recoverableError: { code: 'DISCARD_FAILED' } });
  });

  it('ends a run whose tab closed and that cannot follow anywhere, keeping its Project', async () => {
    const { lifecycle, state } = setup(liveRun);
    await lifecycle.recordedTabGone(4);
    expect(state()).toMatchObject({
      phase: 'error',
      sessionId: 'project-1',
      recoverableError: { code: 'RECORDED_TAB_CLOSED' },
    });
  });

  it("trusts extension pages and the recorded tab's top frame only", () => {
    const { lifecycle, actor } = setup(liveRun);
    return actor.ready().then(() => {
      expect(lifecycle.isTrustedControlSender('run-1', { url: `${EXTENSION_ORIGIN}popup.html` })).toBe(true);
      expect(lifecycle.isTrustedControlSender('run-1', { frameId: 0, tab: { id: 4 } })).toBe(true);
      expect(lifecycle.isTrustedControlSender('run-1', { frameId: 2, tab: { id: 4 } })).toBe(false);
      expect(lifecycle.isTrustedControlSender('run-1', { frameId: 0, tab: { id: 5 } })).toBe(false);
    });
  });
});
