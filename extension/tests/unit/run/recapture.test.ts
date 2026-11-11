import { describe, expect, it, vi } from 'vitest';
import { createRecapture, type RecaptureSources } from '@/lib/recording/run/recapture';
import { createRecorderGate } from '@/lib/recording/run/recorder-gate';
import { toRecordingState } from '@/lib/recording/run/state';
import type { StepRecaptureContext } from '@/lib/storage/recording-state';
import { StepRecaptureError } from '@/lib/storage/step-repository';
import { makeRecordingState } from '../../setup/recording-state';
import { fakeActor, fakePorts, PAGE_URL, tab } from './fakes';

const editor = { url: 'chrome-extension://howbeam/editor.html?session=project-1', tab: tab({ id: 2 }) };
const source = { frameId: 0, url: PAGE_URL, tab: tab({ id: 7, windowId: 3 }) };
const target = { kind: 'single' as const, stepId: 'step-1' };

function context(phase: StepRecaptureContext['phase']): StepRecaptureContext {
  return { runId: 'r1', sessionId: 'project-1', target, entryId: 'step-1', phase, sourceTabId: 7, sourceWindowId: 3, sourceUrl: PAGE_URL, sourceTabCreated: true, startedAt: 1 };
}

async function setup(stored = makeRecordingState()) {
  const { ports } = fakePorts();
  const { actor } = fakeActor(stored);
  const gate = createRecorderGate(50);
  const sources = {
    isEditorSenderForSession: vi.fn((sender, sessionId: string) => sender.url === editor.url && sessionId === 'project-1'),
    validateTarget: vi.fn(async () => ({ target, entryId: 'step-1', sourceUrl: PAGE_URL })),
    permissionPreflight: vi.fn(() => ({ ok: true as const, sourceUrl: PAGE_URL, sourceOrigin: 'https://site.example', permissionPattern: 'https://site.example/*' })),
    checkPermission: vi.fn(async () => 'granted' as const),
    openSourceTab: vi.fn(async () => ({ ok: true as const, source: { tab: tab({ id: 7, windowId: 3 }), reused: false } })),
    withUncommittedTab: vi.fn((_source, body) => body(() => {})),
    replaceCapture: vi.fn(async () => ({})),
    wasCommitted: vi.fn(async () => false),
    isSourceTabIntact: vi.fn(async () => true),
    closeTab: vi.fn(async () => {}),
  } satisfies RecaptureSources;
  ports.tabs.activeInWindow.mockResolvedValue(tab({ id: 7, windowId: 3 }));
  const recapture = createRecapture({ actor, ports, gate, sources, discardUndo: vi.fn() });
  // The injected recapture recorder reports ready.
  ports.recorder.inject.mockImplementation(async () => {
    queueMicrotask(() => void recapture.handleReady({ type: 'HOWBEAM_RECAPTURE_READY', runId: 'id-1', url: PAGE_URL }, source));
  });
  await actor.ready();
  return { recapture, ports, sources, actor, state: () => toRecordingState(actor.state()) };
}

const targetMessage = {
  type: 'HOWBEAM_RECAPTURE_TARGET' as const, runId: 'r1', captureId: 'cap-1', rect: { x: 1, y: 1, width: 5, height: 5 },
  viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 }, devicePixelRatio: 1, url: PAGE_URL, timestamp: 4,
};

describe('recapture', () => {
  it('opens the source tab, waits for its recorder and asks for the target', async () => {
    const run = await setup();
    await expect(run.recapture.start({ type: 'START_STEP_RECAPTURE', sessionId: 'project-1', target }, editor))
      .resolves.toEqual({ ok: true, runId: 'id-1', tabId: 7, reusedTab: false });
    expect(run.state()).toMatchObject({ operation: 'recapture', recapture: { phase: 'awaiting-target', sourceTabCreated: true } });
    expect(run.ports.tabs.focus).toHaveBeenCalledWith(7, 3);
  });

  it('refuses another editor, and a start while something is running', async () => {
    const run = await setup();
    await expect(run.recapture.start({ type: 'START_STEP_RECAPTURE', sessionId: 'project-1', target }, source))
      .resolves.toMatchObject({ ok: false, code: 'INVALID_EDITOR' });
    const busy = await setup(makeRecordingState({ operation: 'recapture', sessionId: 'project-1', recapture: context('awaiting-target') }));
    await expect(busy.recapture.start({ type: 'START_STEP_RECAPTURE', sessionId: 'project-1', target }, editor))
      .resolves.toMatchObject({ ok: false, code: 'ACTIVE_OPERATION' });
  });

  it('replaces the screenshot, settles, closes the tab it opened and goes back to the editor', async () => {
    const run = await setup(makeRecordingState({ operation: 'recapture', sessionId: 'project-1', recapture: context('awaiting-target') }));
    await expect(run.recapture.handleTarget(targetMessage, source)).resolves.toEqual({ ok: true, status: 'replaced' });
    expect(run.sources.replaceCapture).toHaveBeenCalledWith('project-1', target, expect.objectContaining({ bounds: targetMessage.rect }), 'r1');
    expect(run.state()).toMatchObject({ operation: null, recapture: null, recaptureResult: { runId: 'r1', status: 'replaced' } });
    expect(run.sources.closeTab).toHaveBeenCalledWith(7);
    expect(run.ports.editor.open).toHaveBeenCalledWith({ sessionId: 'project-1', entryId: 'step-1' });
  });

  it('settles a refused replacement with the copy for its reason', async () => {
    const run = await setup(makeRecordingState({ operation: 'recapture', sessionId: 'project-1', recapture: context('awaiting-target') }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    run.sources.replaceCapture.mockRejectedValue(new StepRecaptureError('TARGET_CHANGED', 'changed'));
    await expect(run.recapture.handleTarget(targetMessage, source)).resolves.toEqual({ ok: false, status: 'failed', error: 'recaptureFlow.stepChanged' });
    expect(run.state()).toMatchObject({ error: 'recaptureFlow.stepChanged', recaptureResult: { status: 'failed', errorCode: 'TARGET_CHANGED' } });
  });

  it('cancels, and the editor acknowledges the result', async () => {
    const run = await setup(makeRecordingState({ operation: 'recapture', sessionId: 'project-1', recapture: context('awaiting-target') }));
    await expect(run.recapture.cancel({ type: 'CANCEL_STEP_RECAPTURE', runId: 'r1' }, editor)).resolves.toEqual({ ok: true, status: 'cancelled' });
    await expect(run.recapture.cancel({ type: 'CANCEL_STEP_RECAPTURE', runId: 'r1' }, editor)).resolves.toEqual({ ok: true, status: 'already-completed' });
    await expect(run.recapture.acknowledge({ type: 'ACK_STEP_RECAPTURE_RESULT', runId: 'r1', sessionId: 'project-1' }, editor)).resolves.toBe(true);
    expect(run.state()).toMatchObject({ recaptureResult: null });
  });

  it('fails when the source tab navigates once the target is being chosen', async () => {
    const run = await setup(makeRecordingState({ operation: 'recapture', sessionId: 'project-1', recapture: context('awaiting-target') }));
    await expect(run.recapture.handleSourceTabUpdated(7, { status: 'loading' })).resolves.toBe(true);
    expect(run.state()).toMatchObject({ recaptureResult: { status: 'failed', errorCode: 'SOURCE_NAVIGATED' } });
    await expect(run.recapture.handleSourceTabUpdated(5, { status: 'loading' })).resolves.toBe(false);
  });

  it.each([
    ['a capture that was committed', 'capturing', true, 'replaced'],
    ['a capture that was not', 'capturing', false, 'failed'],
  ] as const)('settles %s after a worker restart', async (_name, phase, committed, status) => {
    const run = await setup(makeRecordingState({ operation: 'recapture', sessionId: 'project-1', recapture: context(phase) }));
    run.sources.wasCommitted.mockResolvedValue(committed);
    await run.recapture.recover();
    expect(run.state()).toMatchObject({ operation: null, recaptureResult: { status } });
  });

  it('keeps target selection across a worker restart while the source tab is intact', async () => {
    const run = await setup(makeRecordingState({ operation: 'recapture', sessionId: 'project-1', recapture: context('awaiting-target') }));
    await run.recapture.recover();
    expect(run.state()).toMatchObject({ operation: 'recapture' });
  });
});
