import { describe, expect, it } from 'vitest';
import { documentRole, type DocumentFrame } from '@/lib/recording/content/document-role';
import { makeRecordingState } from '../setup/recording-state';

const TOP: DocumentFrame = { isTop: true, unrecordable: null, underUnrecordablePage: false };
const CHILD: DocumentFrame = { isTop: false, unrecordable: null, underUnrecordablePage: false };

function recording(overrides: Parameters<typeof makeRecordingState>[0] = {}) {
  return makeRecordingState({
    operation: 'recording',
    isRecording: true,
    runId: 'run-1',
    phase: 'recording',
    ...overrides,
  });
}

describe('documentRole', () => {
  it('runs nothing without a live run', () => {
    expect(documentRole(makeRecordingState(), TOP)).toEqual({ kind: 'none' });
    expect(documentRole(recording({ runId: null }), TOP)).toEqual({ kind: 'none' });
  });

  it('puts the recapture picker in the top frame and probes in its children', () => {
    const recapture = { runId: 'recapture-1' } as never;
    const state = makeRecordingState({ operation: 'recapture', recapture });
    expect(documentRole(state, TOP)).toEqual({ kind: 'recapture', context: recapture });
    expect(documentRole(state, CHILD)).toEqual({ kind: 'probe', runId: 'recapture-1', freeze: false });
  });

  it('records steps in the top frame and relays them from child frames', () => {
    expect(documentRole(recording(), TOP)).toEqual({
      kind: 'top',
      runId: 'run-1',
      unrecordable: null,
      freezeSnapshot: false,
    });
    expect(documentRole(recording({ phase: 'paused' }), CHILD)).toEqual({
      kind: 'step-child',
      runId: 'run-1',
      paused: true,
    });
  });

  it('leaves child frames alone under a page that cannot be recorded', () => {
    expect(documentRole(recording(), { ...CHILD, underUnrecordablePage: true })).toEqual({ kind: 'none' });
  });

  it('freezes a snapshot in every frame, except while the next page is being chosen', () => {
    const snapshot = recording({ mode: 'snapshot' });
    expect(documentRole(snapshot, TOP)).toEqual({
      kind: 'top',
      runId: 'run-1',
      unrecordable: null,
      freezeSnapshot: true,
    });
    expect(documentRole(snapshot, CHILD)).toEqual({ kind: 'probe', runId: 'run-1', freeze: true });

    const choosing = recording({ mode: 'snapshot', phase: 'preparing-next' });
    expect(documentRole(choosing, TOP)).toEqual({
      kind: 'top',
      runId: 'run-1',
      unrecordable: null,
      freezeSnapshot: false,
    });
    expect(documentRole(choosing, CHILD)).toEqual({ kind: 'none' });
  });

  it('shows only the toolbar on a page that cannot be recorded, never a frozen snapshot', () => {
    expect(documentRole(recording({ mode: 'snapshot' }), { ...TOP, unrecordable: 'pdf-viewer' })).toEqual({
      kind: 'top',
      runId: 'run-1',
      unrecordable: 'pdf-viewer',
      freezeSnapshot: false,
    });
  });
});
