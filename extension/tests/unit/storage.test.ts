import { describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: {} }));

import { normalizeRecordingState } from '@/lib/storage/storage';
import { createDefaultRecordingState } from '@/lib/storage/recording-state';

describe('recording state normalization', () => {
  it('returns an independent complete default after storage is cleared', () => {
    const first = normalizeRecordingState(undefined);
    const second = createDefaultRecordingState();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('normalizes a valid recapture operation without treating it as ordinary recording', () => {
    const normalized = normalizeRecordingState({
      operation: 'recapture',
      isRecording: false,
      recapture: {
        runId: 'recapture-1',
        sessionId: 'session-1',
        target: { kind: 'single', stepId: 'step-1' },
        entryId: 'step-1',
        phase: 'awaiting-target',
        sourceTabId: 11,
        sourceWindowId: 3,
        sourceUrl: 'https://example.com/page',
        sourceTabCreated: false,
        startedAt: 123,
      },
    });

    expect(normalized.operation).toBe('recapture');
    expect(normalized.isRecording).toBe(false);
    expect(normalized.phase).toBe('idle');
    expect(normalized.recapture?.target).toEqual({ kind: 'single', stepId: 'step-1' });
  });

  it('ignores retired recapture fields left behind by an older build', () => {
    // editorTabId/editorWindowId were dropped when the editor gained a single
    // shared tab. A state written before that must still normalize, because the
    // normalizer rebuilds the context from the fields it knows.
    const normalized = normalizeRecordingState({
      operation: 'recapture',
      recapture: {
        runId: 'recapture-1',
        sessionId: 'session-1',
        target: { kind: 'single', stepId: 'step-1' },
        entryId: 'step-1',
        phase: 'awaiting-target',
        editorTabId: 10,
        editorWindowId: 2,
        sourceTabId: 11,
        sourceWindowId: 3,
        sourceUrl: 'https://example.com/page',
        sourceTabCreated: false,
        startedAt: 123,
      } as never,
    });

    expect(normalized.operation).toBe('recapture');
    expect(normalized.recapture).not.toHaveProperty('editorTabId');
    expect(normalized.recapture).not.toHaveProperty('editorWindowId');
    expect(normalized.recapture?.sourceTabId).toBe(11);
  });

  it('fails closed when a persisted recapture context is incomplete', () => {
    const normalized = normalizeRecordingState({
      operation: 'recapture',
      recapture: { runId: 'missing-fields' } as never,
    });

    expect(normalized.operation).toBeNull();
    expect(normalized.recapture).toBeNull();
  });

  it('keeps only structurally valid durable recapture results', () => {
    const valid = normalizeRecordingState({
      recaptureResult: {
        runId: 'run-1',
        status: 'replaced',
        sessionId: 'session-1',
        entryId: 'step-1',
        completedAt: 456,
      },
    });
    const invalid = normalizeRecordingState({
      recaptureResult: { runId: 'run-1', status: 'unknown' } as never,
    });

    expect(valid.recaptureResult?.status).toBe('replaced');
    expect(invalid.recaptureResult).toBeNull();
  });

  it('rebuilds persisted state field-by-field and rejects malformed active recording identity', () => {
    const normalized = normalizeRecordingState({
      operation: 'recording',
      isRecording: true,
      phase: 'recording',
      sessionId: {} as never,
      tabId: -1,
      runId: [] as never,
      error: [] as never,
      recoverableError: { code: '', message: 'broken' },
      itemCount: -4,
      numbered: 'yes' as never,
      groupAnchorId: {} as never,
      snapshotViewport: { width: Number.NaN, height: 100, scrollX: 0, scrollY: 0 },
      snapshotDevicePixelRatio: Number.POSITIVE_INFINITY,
      unexpected: 'must not survive',
    } as never);

    expect(normalized).toEqual(createDefaultRecordingState());
    expect(normalized).not.toHaveProperty('unexpected');
  });

  it.each([
    { viewport: { width: -1, height: 100, scrollX: 0, scrollY: 0 }, ratio: 1, validViewport: false },
    { viewport: { width: 100, height: 100, scrollX: 10_000_001, scrollY: 0 }, ratio: 1, validViewport: false },
    { viewport: { width: 100, height: 100, scrollX: 0, scrollY: 0 }, ratio: 0, validViewport: true },
    { viewport: { width: 100, height: 100, scrollX: 0, scrollY: 0 }, ratio: 33, validViewport: true },
  ])('drops invalid snapshot geometry while preserving a valid recording identity %#', ({ viewport, ratio, validViewport }) => {
    const normalized = normalizeRecordingState({
      operation: 'recording',
      isRecording: true,
      phase: 'recording',
      sessionId: 'session-1',
      tabId: 2,
      runId: 'run-1',
      mode: 'snapshot',
      snapshotViewport: viewport,
      snapshotDevicePixelRatio: ratio,
    });

    expect(normalized.operation).toBe('recording');
    expect(normalized.snapshotViewport).toEqual(validViewport ? viewport : null);
    expect(normalized.snapshotDevicePixelRatio).toBe(ratio === 1 ? 1 : null);
  });

  it('keeps newProject only while its run is alive', () => {
    const liveRun = {
      operation: 'recording',
      isRecording: true,
      phase: 'recording',
      sessionId: 'session-1',
      tabId: 2,
      runId: 'run-1',
      newProject: true,
    } as const;

    expect(normalizeRecordingState(liveRun).newProject).toBe(true);
    expect(normalizeRecordingState({ ...liveRun, operation: null, isRecording: false }).newProject).toBe(false);
    expect(normalizeRecordingState({ ...liveRun, newProject: 'yes' as never }).newProject).toBe(false);
  });

  it('clears stale snapshot-only fields when the persisted mode is steps', () => {
    const normalized = normalizeRecordingState({
      operation: 'recording',
      isRecording: true,
      phase: 'recording',
      sessionId: 'session-1',
      tabId: 2,
      runId: 'run-1',
      mode: 'steps',
      groupAnchorId: 'anchor-1',
      snapshotViewport: { width: 100, height: 100, scrollX: 0, scrollY: 0 },
      snapshotDevicePixelRatio: 2,
    });

    expect(normalized.groupAnchorId).toBeNull();
    expect(normalized.snapshotViewport).toBeNull();
    expect(normalized.snapshotDevicePixelRatio).toBeNull();
  });

  it('bounds durable recapture result timestamps and drops copy that does not exist', () => {
    const result = {
      runId: 'run-1',
      status: 'failed',
      sessionId: 'session-1',
      entryId: 'step-1',
      completedAt: 1,
    } as const;

    expect(normalizeRecordingState({ recaptureResult: { ...result, completedAt: -1 } }).recaptureResult).toBeNull();
    expect(normalizeRecordingState({
      recaptureResult: { ...result, copy: '來源頁無法載入' as never },
    }).recaptureResult).toBeNull();
    expect(normalizeRecordingState({ recaptureResult: { ...result, copy: 'recaptureFlow.failed' } }).recaptureResult)
      .toMatchObject({ copy: 'recaptureFlow.failed' });
  });

  it('keeps a stored error only when it names existing copy, never stored text', () => {
    expect(normalizeRecordingState({ error: 'background.captureFailed' }).error).toBe('background.captureFailed');
    expect(normalizeRecordingState({ error: '擷取失敗' as never }).error).toBeNull();
    expect(normalizeRecordingState({ error: 'background.toString' as never }).error).toBeNull();
    expect(normalizeRecordingState({
      recoverableError: { code: 'CAPTURE_FAILED', copy: 'Error: boom' as never },
    }).recoverableError).toBeNull();
  });

  it('fails closed for a persisted recording count beyond the durable project limit', () => {
    const normalized = normalizeRecordingState({
      operation: 'recording',
      isRecording: true,
      phase: 'recording',
      sessionId: 'session-1',
      tabId: 1,
      runId: 'run-1',
      itemCount: 2_001,
    });

    expect(normalized.operation).toBeNull();
    expect(normalized.isRecording).toBe(false);
    expect(normalized.itemCount).toBe(0);
  });


  it('applies the durable identifier limit to active state identities', () => {
    const oversized = 'x'.repeat(257);
    const normalized = normalizeRecordingState({
      operation: 'recording',
      isRecording: true,
      phase: 'recording',
      sessionId: oversized,
      tabId: 1,
      runId: 'run-1',
    });

    expect(normalized.operation).toBeNull();
    expect(normalized.sessionId).toBeNull();
  });

});
