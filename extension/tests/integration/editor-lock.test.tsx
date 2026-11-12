// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: { tabs: { getCurrent: vi.fn(), update: vi.fn() } } }));

import { useEditorLock } from '@/lib/editor/editor-lock';
import { createFakeLockManager } from '../setup/fake-locks';

async function settle() {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: createFakeLockManager() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('editor lock', () => {
  it('lets one tab edit a Project and hands it to the waiting tab once that one leaves', async () => {
    const first = renderHook(() => useEditorLock('project-1'));
    await settle();
    expect(first.result.current.state).toBe('held');

    const second = renderHook(() => useEditorLock('project-1'));
    await settle();
    expect(second.result.current.state).toBe('elsewhere');

    first.unmount();
    await settle();
    expect(second.result.current.state).toBe('held');
  });

  it('does not stand in the way of another Project', async () => {
    renderHook(() => useEditorLock('project-1'));
    const other = renderHook(() => useEditorLock('project-2'));
    await settle();
    expect(other.result.current.state).toBe('held');
  });

  it('has nothing to lock before a Project is chosen', () => {
    expect(renderHook(() => useEditorLock(null)).result.current.state).toBe('held');
  });
});
