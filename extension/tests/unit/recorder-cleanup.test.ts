// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  addRecorderCleanup,
  removeRecorderCleanup,
  runRecorderCleanup,
} from '@/lib/recording/content/recorder-cleanup';

describe('recorder cleanup', () => {
  it('runs each teardown once, and not one that was removed', () => {
    const first = vi.fn();
    const removed = vi.fn();
    addRecorderCleanup(first);
    addRecorderCleanup(removed);
    removeRecorderCleanup(removed);
    runRecorderCleanup();
    runRecorderCleanup();
    expect(first).toHaveBeenCalledOnce();
    expect(removed).not.toHaveBeenCalled();
  });

  it('keeps going when one teardown throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();
    addRecorderCleanup(() => {
      throw new Error('boom');
    });
    addRecorderCleanup(after);
    runRecorderCleanup();
    expect(after).toHaveBeenCalledOnce();
  });

  it('cannot be triggered from the page', () => {
    const teardown = vi.fn();
    addRecorderCleanup(teardown);
    document.dispatchEvent(new CustomEvent('howbeam_cleanup_test-extension'));
    expect(teardown).not.toHaveBeenCalled();
    removeRecorderCleanup(teardown);
  });
});
