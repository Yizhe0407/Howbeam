import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHoverScheduler, type HoverProbeRequest } from '@/entrypoints/snapshot-shield/hover-scheduler';

const HOVER_TIMEOUT_MS = 1_000;

function createHarness() {
  const frames = new Map<number, () => void>();
  let nextFrameId = 1;
  const posts: HoverProbeRequest[] = [];
  const state = { enabled: true, capturing: false };
  const scheduler = createHoverScheduler({
    isEnabled: () => state.enabled,
    isCapturing: () => state.capturing,
    post: (request) => posts.push(request),
    hoverTimeoutMs: HOVER_TIMEOUT_MS,
    requestFrame: (callback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => {
      frames.delete(id);
    },
  });
  const flushFrames = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback();
  };
  return { scheduler, posts, state, frames, flushFrames };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createHoverScheduler', () => {
  it('coalesces input to one frame and keeps at most one probe in flight', () => {
    const { scheduler, posts, frames, flushFrames } = createHarness();
    scheduler.pointerMove(10, 20);
    scheduler.pointerMove(11, 21);
    expect(frames.size).toBe(1);
    flushFrames();
    expect(posts).toEqual([{ requestId: 1, clientX: 11, clientY: 21 }]);

    // While the probe is pending, new input schedules but never posts.
    scheduler.pointerMove(30, 40);
    flushFrames();
    expect(posts).toHaveLength(1);

    // The stale response releases the slot; the follow-up probe carries the
    // latest point.
    expect(scheduler.resolvePreview({ requestId: 1 })).toBe('stale');
    scheduler.schedule();
    flushFrames();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ requestId: 2, clientX: 30, clientY: 40 });
  });

  it('does not re-probe an unchanged point until the sent revision is invalidated', () => {
    const { scheduler, posts, frames, flushFrames } = createHarness();
    scheduler.pointerMove(10, 20);
    flushFrames();
    expect(scheduler.resolvePreview({ requestId: 1 })).toBe('accepted');
    scheduler.schedule();
    expect(frames.size).toBe(0);
    expect(posts).toHaveLength(1);

    // A settled capture may have changed the page under the cursor: the
    // revision reset forces exactly one fresh probe of the same point.
    scheduler.invalidateSentRevision();
    scheduler.schedule();
    flushFrames();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual({ requestId: 2, clientX: 10, clientY: 20 });
  });

  it('abandons an unanswered probe after the timeout and retries; the late response is ignored', () => {
    const { scheduler, posts, flushFrames } = createHarness();
    scheduler.pointerMove(10, 20);
    flushFrames();
    expect(posts).toHaveLength(1);

    vi.advanceTimersByTime(HOVER_TIMEOUT_MS);
    flushFrames();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ requestId: 2, clientX: 10, clientY: 20 });

    // The original probe's response outlived its timeout: never applied.
    expect(scheduler.resolvePreview({ requestId: 1 })).toBe('ignored');
  });

  it('rejects responses that no longer match the pending request, latest request, or point', () => {
    const { scheduler, posts, flushFrames } = createHarness();
    scheduler.pointerMove(10, 20);
    flushFrames();

    // Unknown request ids never touch pending state.
    expect(scheduler.resolvePreview({ requestId: 99 })).toBe('ignored');

    // The point moved after the probe was sent, so its rect no longer describes
    // what is under the cursor.
    scheduler.pointerMove(30, 40);
    expect(scheduler.resolvePreview({ requestId: 1 })).toBe('stale');
    scheduler.schedule();
    flushFrames();
    expect(posts[1]).toMatchObject({ clientX: 30, clientY: 40 });

    // A capture bumped the latest request while this probe was pending.
    const { scheduler: second, posts: secondPosts, flushFrames: flushSecond, state } = createHarness();
    second.pointerMove(10, 20);
    flushSecond();
    expect(secondPosts).toHaveLength(1);
    state.capturing = true;
    second.beginCapture(10, 20);
    state.capturing = false;
    expect(second.resolvePreview({ requestId: 1 })).toBe('stale');
  });

  it('blocks probing while capturing and while disabled', () => {
    const { scheduler, posts, flushFrames, state } = createHarness();
    state.enabled = false;
    scheduler.pointerMove(10, 20);
    flushFrames();
    expect(posts).toHaveLength(0);

    state.enabled = true;
    state.capturing = true;
    scheduler.pointerMove(10, 20);
    flushFrames();
    expect(posts).toHaveLength(0);
  });

  it('beginCapture cancels the scheduled probe', () => {
    const { scheduler, posts, frames, flushFrames } = createHarness();
    scheduler.pointerMove(10, 20);
    expect(frames.size).toBe(1);

    scheduler.beginCapture(10, 20);
    flushFrames();
    expect(posts).toHaveLength(0);
  });

  it('setAnchor moves the point to a keyboard anchor and probes it', () => {
    const { scheduler, posts, flushFrames } = createHarness();
    scheduler.pointerMove(10, 20);
    flushFrames();
    expect(posts[0]).toMatchObject({ clientX: 10, clientY: 20 });
    expect(scheduler.resolvePreview({ requestId: 1 })).toBe('accepted');

    // The anchor bumps the point revision, so the settled point is re-probed
    // even though no pointer moved.
    scheduler.setAnchor(50, 60);
    flushFrames();
    expect(posts[1]).toMatchObject({ clientX: 50, clientY: 60 });
  });

  it('clear drops the point and the pending probe', () => {
    const { scheduler, posts, flushFrames } = createHarness();
    scheduler.pointerMove(10, 20);
    flushFrames();
    expect(posts).toHaveLength(1);
    scheduler.clear();
    expect(scheduler.hasPoint()).toBe(false);
    expect(scheduler.resolvePreview({ requestId: 1 })).toBe('ignored');
    scheduler.schedule();
    flushFrames();
    expect(posts).toHaveLength(1);

    scheduler.pointerMove(30, 40);
    flushFrames();
    expect(posts[1]).toMatchObject({ clientX: 30, clientY: 40 });
  });
});
