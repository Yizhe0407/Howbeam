import { describe, expect, it } from 'vitest';
import {
  buildShieldTokenStorageKey,
  isSnapshotShieldTokenRecord,
  isSnapshotShieldFrameMessage,
  isSnapshotShieldInitMessage,
  isSnapshotShieldPortMessage,
  isSnapshotShieldRegionRect,
  SNAPSHOT_SHIELD_TOKEN_STORAGE_PREFIX,
  SNAPSHOT_SHIELD_CANDIDATES,
  SNAPSHOT_SHIELD_CAPTURE_COMPLETE,
  SNAPSHOT_SHIELD_MARKS,
  SNAPSHOT_SHIELD_CONTROL,
  SNAPSHOT_SHIELD_INIT,
  SNAPSHOT_SHIELD_POINTER_DOWN,
  SNAPSHOT_SHIELD_POINTER_MOVE,
  SNAPSHOT_SHIELD_PREVIEW,
  SNAPSHOT_SHIELD_READY,
  SNAPSHOT_SHIELD_REGION_CAPTURE,
} from '@/lib/recording/snapshot-shield-protocol';

describe('snapshot shield protocol', () => {
  const token = 'run-token';

  it('accepts only initialization for the current shield token', () => {
    expect(isSnapshotShieldInitMessage({ type: SNAPSHOT_SHIELD_INIT, token }, token)).toBe(true);
    expect(isSnapshotShieldInitMessage({ type: SNAPSHOT_SHIELD_INIT, token: 'old-token' }, token)).toBe(false);
    expect(isSnapshotShieldInitMessage(null, token)).toBe(false);
    expect(isSnapshotShieldInitMessage({ type: SNAPSHOT_SHIELD_INIT, token, theme: 'dark' }, token)).toBe(true);
    expect(isSnapshotShieldInitMessage({ type: SNAPSHOT_SHIELD_INIT, token, theme: 'neon' }, token)).toBe(false);
  });

  it('validates ready and finite pointer coordinates', () => {
    expect(isSnapshotShieldPortMessage({ type: SNAPSHOT_SHIELD_READY, token }, token)).toBe(true);
    expect(
      isSnapshotShieldPortMessage(
        { type: SNAPSHOT_SHIELD_POINTER_DOWN, token, captureId: 1, clientX: 120, clientY: 80 },
        token,
      ),
    ).toBe(true);
    // A pointer-down without its capture generation can never be matched to a
    // completion, so it is rejected outright.
    expect(
      isSnapshotShieldPortMessage({ type: SNAPSHOT_SHIELD_POINTER_DOWN, token, clientX: 120, clientY: 80 }, token),
    ).toBe(false);
    expect(
      isSnapshotShieldPortMessage(
        { type: SNAPSHOT_SHIELD_POINTER_DOWN, token, captureId: -1, clientX: 120, clientY: 80 },
        token,
      ),
    ).toBe(false);
    expect(
      isSnapshotShieldPortMessage(
        { type: SNAPSHOT_SHIELD_POINTER_DOWN, token, captureId: 1, clientX: Number.NaN, clientY: 80 },
        token,
      ),
    ).toBe(false);
    expect(
      isSnapshotShieldPortMessage(
        { type: SNAPSHOT_SHIELD_POINTER_DOWN, token, captureId: 1, clientX: -1, clientY: 80 },
        token,
      ),
    ).toBe(false);
    expect(
      isSnapshotShieldPortMessage(
        {
          type: SNAPSHOT_SHIELD_POINTER_MOVE,
          token,
          requestId: 4,
          clientX: 120,
          clientY: 80,
        },
        token,
      ),
    ).toBe(true);
    expect(
      isSnapshotShieldPortMessage(
        {
          type: SNAPSHOT_SHIELD_POINTER_MOVE,
          token,
          requestId: -1,
          clientX: 120,
          clientY: 80,
        },
        token,
      ),
    ).toBe(false);
    expect(isSnapshotShieldPortMessage({ type: SNAPSHOT_SHIELD_READY, token: 'old-token' }, token)).toBe(false);
  });

  it('authenticates and validates region capture rectangles', () => {
    const rect = { x: 10, y: 20, width: 30, height: 40 };
    expect(isSnapshotShieldRegionRect(rect)).toBe(true);
    expect(
      isSnapshotShieldPortMessage({ type: SNAPSHOT_SHIELD_REGION_CAPTURE, token, captureId: 2, rect }, token),
    ).toBe(true);
    expect(isSnapshotShieldPortMessage({ type: SNAPSHOT_SHIELD_REGION_CAPTURE, token, rect }, token)).toBe(false);
    expect(
      isSnapshotShieldPortMessage(
        { type: SNAPSHOT_SHIELD_REGION_CAPTURE, token: 'old-token', captureId: 2, rect },
        token,
      ),
    ).toBe(false);

    for (const invalidRect of [
      { ...rect, x: -1 },
      { ...rect, width: 7 },
      { ...rect, height: Number.NaN },
      { ...rect, x: Number.POSITIVE_INFINITY },
      { x: 999_990, y: 20, width: 30, height: 40 },
    ]) {
      expect(isSnapshotShieldRegionRect(invalidRect)).toBe(false);
      expect(
        isSnapshotShieldPortMessage(
          { type: SNAPSHOT_SHIELD_REGION_CAPTURE, token, captureId: 2, rect: invalidRect },
          token,
        ),
      ).toBe(false);
    }
  });

  it('validates preview and committed selection messages sent back to the frame', () => {
    const rect = { x: 20, y: 30, width: 100, height: 40 };
    const selection = { id: 1, rect, label: 2 };
    expect(isSnapshotShieldFrameMessage({ type: SNAPSHOT_SHIELD_PREVIEW, token, requestId: 3, rect }, token)).toBe(
      true,
    );
    // A preview clears the highlight by carrying a null rect, so that stays
    // valid; anything without a usable request id does not.
    expect(
      isSnapshotShieldFrameMessage({ type: SNAPSHOT_SHIELD_PREVIEW, token, requestId: 3, rect: null }, token),
    ).toBe(true);
    expect(isSnapshotShieldFrameMessage({ type: SNAPSHOT_SHIELD_PREVIEW, token, requestId: -1, rect }, token)).toBe(
      false,
    );
    expect(
      isSnapshotShieldFrameMessage({ type: SNAPSHOT_SHIELD_PREVIEW, token: 'old-token', requestId: 3, rect }, token),
    ).toBe(false);
    expect(
      isSnapshotShieldFrameMessage({ type: SNAPSHOT_SHIELD_CAPTURE_COMPLETE, token, captureId: 5, selection }, token),
    ).toBe(true);
    expect(
      isSnapshotShieldFrameMessage(
        { type: SNAPSHOT_SHIELD_CAPTURE_COMPLETE, token, captureId: 5, selection: null },
        token,
      ),
    ).toBe(true);
    // Completions must echo the capture generation they settle.
    expect(isSnapshotShieldFrameMessage({ type: SNAPSHOT_SHIELD_CAPTURE_COMPLETE, token, selection }, token)).toBe(
      false,
    );
    const mark = { ...selection, id: 1, label: 1 };
    expect(isSnapshotShieldFrameMessage({ type: SNAPSHOT_SHIELD_MARKS, token, marks: [mark] }, token)).toBe(true);
    expect(isSnapshotShieldFrameMessage({ type: SNAPSHOT_SHIELD_MARKS, token, marks: [] }, token)).toBe(true);
    // A mark's id and label are its position: a gap or a mismatch is malformed.
    expect(
      isSnapshotShieldFrameMessage(
        { type: SNAPSHOT_SHIELD_MARKS, token, marks: [{ ...mark, id: 2, label: 2 }] },
        token,
      ),
    ).toBe(false);
    expect(
      isSnapshotShieldFrameMessage({ type: SNAPSHOT_SHIELD_MARKS, token, marks: [{ ...mark, label: 0 }] }, token),
    ).toBe(false);
    expect(
      isSnapshotShieldFrameMessage(
        {
          type: SNAPSHOT_SHIELD_PREVIEW,
          token,
          requestId: 3,
          rect: { ...rect, width: -1 },
        },
        token,
      ),
    ).toBe(false);
  });

  it('accepts the multi-snapshot controls and rejects unknown actions', () => {
    for (const action of [
      'PREPARE_NEXT_SNAPSHOT',
      'CREATE_NEXT_SNAPSHOT',
      'REBUILD_INVALIDATED_SNAPSHOT',
      'DISCARD_CURRENT_RECORDING',
    ]) {
      expect(isSnapshotShieldPortMessage({ type: SNAPSHOT_SHIELD_CONTROL, token, requestId: 8, action }, token)).toBe(
        true,
      );
    }
    expect(
      isSnapshotShieldPortMessage(
        { type: SNAPSHOT_SHIELD_CONTROL, token, requestId: 8, action: 'REPLACE_SNAPSHOT' },
        token,
      ),
    ).toBe(false);
  });

  it('validates keyboard candidate messages', () => {
    expect(
      isSnapshotShieldFrameMessage(
        { type: SNAPSHOT_SHIELD_CANDIDATES, token, anchors: [{ x: 10, y: 20, label: 'Submit' }] },
        token,
      ),
    ).toBe(true);
    expect(isSnapshotShieldFrameMessage({ type: SNAPSHOT_SHIELD_CANDIDATES, token, anchors: [] }, token)).toBe(true);
    expect(
      isSnapshotShieldFrameMessage(
        { type: SNAPSHOT_SHIELD_CANDIDATES, token, anchors: [{ x: Number.NaN, y: 0, label: 'x' }] },
        token,
      ),
    ).toBe(false);
    expect(
      isSnapshotShieldFrameMessage(
        { type: SNAPSHOT_SHIELD_CANDIDATES, token, anchors: [{ x: 0, y: 0, label: 42 }] },
        token,
      ),
    ).toBe(false);
    expect(isSnapshotShieldFrameMessage({ type: SNAPSHOT_SHIELD_CANDIDATES, token: 'old', anchors: [] }, token)).toBe(
      false,
    );
  });

  it('builds namespaced storage keys for shield init tokens', () => {
    expect(buildShieldTokenStorageKey('frame-1')).toBe(`${SNAPSHOT_SHIELD_TOKEN_STORAGE_PREFIX}frame-1`);
  });

  it('validates shield init token records fetched from extension storage', () => {
    expect(isSnapshotShieldTokenRecord({ token: 'secret', createdAt: 123 })).toBe(true);
    expect(isSnapshotShieldTokenRecord(null)).toBe(false);
    expect(isSnapshotShieldTokenRecord({ token: '', createdAt: 123 })).toBe(false);
    expect(isSnapshotShieldTokenRecord({ token: 'x'.repeat(257), createdAt: 123 })).toBe(false);
    expect(isSnapshotShieldTokenRecord({ token: 'secret', createdAt: Number.NaN })).toBe(false);
    expect(isSnapshotShieldTokenRecord({ token: 42, createdAt: 123 })).toBe(false);
  });
});
