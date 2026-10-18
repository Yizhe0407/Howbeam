import { describe, expect, it } from 'vitest';
import {
  isCancelStepRecaptureResult,
  isClickCaptureResult,
  isEditorHandoffResult,
  isFocusStepRecaptureSourceResult,
  isOpenEditorResult,
  isOpenLibraryResult,
  isPreflightProjectContinuationSourcePermissionResult,
  isPreflightStepRecaptureSourcePermissionResult,
  isRecordingControlResult,
  isResetProjectResult,
  isRuntimeBoolean,
  isStartRecordingResult,
  isStartStepRecaptureResult,
  isStepRecaptureTargetResult,
  requireRuntimeMessageResult,
  type RuntimeMessageResultGuard,
} from '@/lib/runtime/runtime-message-result';

describe('requireRuntimeMessageResult', () => {
  it('returns a response only after its contract-specific guard accepts it', () => {
    const result = { ok: true as const, value: 3 };
    const guard: RuntimeMessageResultGuard<typeof result> = (value): value is typeof result => (
      typeof value === 'object' &&
      value !== null &&
      (value as { ok?: unknown }).ok === true &&
      (value as { value?: unknown }).value === 3
    );
    expect(requireRuntimeMessageResult(result, guard)).toBe(result);
  });

  it.each([null, undefined, {}, { ok: 'yes' }, { ok: true, value: 'wrong' }])(
    'turns a missing or contract-invalid response into a useful transport error: %j',
    (value) => {
      const guard = (candidate: unknown): candidate is { ok: true; value: number } => (
        typeof candidate === 'object' &&
        candidate !== null &&
        (candidate as { ok?: unknown }).ok === true &&
        typeof (candidate as { value?: unknown }).value === 'number'
      );
      expect(() => requireRuntimeMessageResult(value, guard, 'background unavailable'))
        .toThrow('background unavailable');
    },
  );
});

describe('runtime response contracts', () => {
  it.each([
    ['start recording', isStartRecordingResult, { ok: true, sessionId: 'project-1', runId: 'run-1' }],
    ['reset Project', isResetProjectResult, { ok: true, contentRevision: 3 }],
    ['open editor', isOpenEditorResult, { ok: false, error: 'cannot open' }],
    ['open library', isOpenLibraryResult, { ok: true }],
    ['editor handoff consenting to navigation', isEditorHandoffResult, { ok: true, ready: false }],
    ['editor handoff already showing the target', isEditorHandoffResult, { ok: true, ready: true }],
    ['editor handoff refused by a draft', isEditorHandoffResult, { ok: false, error: '請先確認草稿。' }],
    [
      'recording control',
      isRecordingControlResult,
      {
        ok: true,
        undoToken: 'undo-1',
        removedItemNumber: 2,
        finish: { sessionId: 'project-1', entryId: 'step-1', itemCount: 2 },
      },
    ],
    [
      'recapture preflight',
      isPreflightStepRecaptureSourcePermissionResult,
      { ok: false, code: 'TARGET_CHANGED', message: 'target changed' },
    ],
    [
      'continuation preflight',
      isPreflightProjectContinuationSourcePermissionResult,
      {
        ok: true,
        sourceUrl: 'https://example.com/page',
        sourceOrigin: 'https://example.com',
        permissionPattern: 'https://example.com/*',
      },
    ],
    [
      'start recapture',
      isStartStepRecaptureResult,
      { ok: true, runId: 'run-1', tabId: 5, reusedTab: true },
    ],
    ['focus recapture source', isFocusStepRecaptureSourceResult, { ok: true }],
    ['cancel recapture', isCancelStepRecaptureResult, { ok: true, status: 'already-completed' }],
    ['click capture', isClickCaptureResult, { ok: false, error: 'wrong-phase' }],
    ['reported click capture failure', isClickCaptureResult, { ok: false, error: 'capture-failed', reported: true }],
    ['recapture target', isStepRecaptureTargetResult, { ok: false, status: 'rejected', error: 'retry' }],
    ['readiness boolean', isRuntimeBoolean, true],
  ] as const)('accepts a complete %s response', (_name, guard, value) => {
    expect(guard(value)).toBe(true);
  });

  it.each([
    ['start recording without a run id', isStartRecordingResult, { ok: true, sessionId: 'project-1' }],
    ['reset with a fractional revision', isResetProjectResult, { ok: true, contentRevision: 1.5 }],
    ['open editor with undeclared payload', isOpenEditorResult, { ok: true, error: 'hidden' }],
    // The background must be able to tell "not our editor page" from consent.
    ['editor handoff omitting readiness', isEditorHandoffResult, { ok: true }],
    ['editor handoff with non-boolean readiness', isEditorHandoffResult, { ok: true, ready: 'yes' }],
    [
      'recording control with a malformed finish payload',
      isRecordingControlResult,
      { ok: true, finish: { sessionId: 'project-1', entryId: null, itemCount: -1 } },
    ],
    [
      'recording control whose finish payload carries a retired field',
      isRecordingControlResult,
      { ok: true, finish: { sessionId: 'project-1', entryId: null, groupId: null, itemCount: 1 } },
    ],
    [
      'recapture preflight with unsupported error code',
      isPreflightStepRecaptureSourcePermissionResult,
      { ok: false, code: 'PROJECT_ARCHIVED', message: 'nope' },
    ],
    [
      'continuation preflight borrowing a recapture-only error code',
      isPreflightProjectContinuationSourcePermissionResult,
      { ok: false, code: 'TARGET_CHANGED', message: 'nope' },
    ],
    [
      'start recapture with a negative tab id',
      isStartStepRecaptureResult,
      { ok: true, runId: 'run-1', tabId: -1, reusedTab: false },
    ],
    ['focus recapture source without an error', isFocusStepRecaptureSourceResult, { ok: false }],
    ['cancel recapture with an unknown status', isCancelStepRecaptureResult, { ok: true, status: 'pending' }],
    ['click capture with undeclared payload', isClickCaptureResult, { ok: true, captured: true }],
    ['click capture failure without a reason', isClickCaptureResult, { ok: false }],
    ['click capture with a non-true reported flag', isClickCaptureResult, { ok: false, error: 'x', reported: false }],
    ['recapture target with mismatched success status', isStepRecaptureTargetResult, { ok: true, status: 'failed' }],
    ['truthy non-boolean readiness', isRuntimeBoolean, 1],
  ] as const)('rejects %s', (_name, guard, value) => {
    expect(guard(value)).toBe(false);
  });

  it('bounds runtime-provided identifiers and error text before rendering or storing them', () => {
    expect(isStartRecordingResult({ ok: true, sessionId: 'g', runId: 'r'.repeat(257) })).toBe(false);
    expect(isOpenEditorResult({ ok: false, error: 'x'.repeat(4_097) })).toBe(false);
  });
});
