// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const mocks = vi.hoisted(() => ({
  createRoot: vi.fn(),
  render: vi.fn(),
}));

vi.mock('react-dom/client', () => ({
  createRoot: (container: Element) => {
    mocks.createRoot(container);
    return { render: mocks.render, unmount: vi.fn() };
  },
}));
vi.mock('@/lib/recording/recording-toolbar', () => ({ default: () => null }));

const { mountRecordingToolbar, TOOLBAR_NOTICE_MS } = await import('@/lib/recording/recording-toolbar-host');

const state = { runId: 'run-1', mode: 'steps' as const, phase: 'recording' as const, itemCount: 0, error: null };
const options = { onCommand: vi.fn(async () => ({ ok: true as const })) };
const lastProps = () => (mocks.render.mock.calls.at(-1)?.[0] as ReactElement<Record<string, unknown>> | null)?.props;

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.querySelectorAll('[data-howbeam-recording-toolbar]').forEach((node) => node.remove());
});

describe('mountRecordingToolbar', () => {
  it('reuses one host and one React root across recording runs instead of leaking one per run', () => {
    const first = mountRecordingToolbar(state, options);
    first.remove();
    expect(first.host.isConnected).toBe(false);
    // The run's tree is unmounted, the root itself is kept.
    expect(mocks.render).toHaveBeenLastCalledWith(null);

    const second = mountRecordingToolbar(state, options);
    second.remove();
    const third = mountRecordingToolbar(state, options);

    expect(mocks.createRoot).toHaveBeenCalledTimes(1);
    expect(third.host).toBe(first.host);
    expect(third.host.isConnected).toBe(true);
    expect(document.querySelectorAll('[data-howbeam-recording-toolbar]')).toHaveLength(1);
    third.remove();
  });

  it('ignores a stale handle so it cannot tear down a newer run', () => {
    const stale = mountRecordingToolbar(state, options);
    const current = mountRecordingToolbar(state, options);
    stale.remove();
    stale.update({ ...state, itemCount: 9 });
    expect(current.host.isConnected).toBe(true);
    expect(lastProps()?.state).toEqual(state);
    current.remove();
  });

  it('shows a transient notice that clears itself, and a persistent one that stays', () => {
    vi.useFakeTimers();
    const toolbar = mountRecordingToolbar(state, options);
    toolbar.showNotice('lost click');
    expect(lastProps()?.notice).toBe('lost click');
    vi.advanceTimersByTime(TOOLBAR_NOTICE_MS);
    expect(lastProps()?.notice).toBeNull();

    toolbar.showNotice('cannot record here', { persistent: true });
    vi.advanceTimersByTime(TOOLBAR_NOTICE_MS * 3);
    expect(lastProps()?.notice).toBe('cannot record here');
    toolbar.remove();
  });
});
