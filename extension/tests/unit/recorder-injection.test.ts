import { afterEach, describe, expect, it, vi } from 'vitest';
import { injectRecorderScript } from '@/lib/recording/recorder-injection';

afterEach(() => vi.restoreAllMocks());

describe('injectRecorderScript', () => {
  it('injects all frames in snapshot mode when host access is available', async () => {
    const execute = vi.fn(async () => []);

    await injectRecorderScript(execute, 7, true);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ tabId: 7, allFrames: true });
  });

  it('falls back to the top frame when a child frame rejects injection', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const execute = vi.fn().mockRejectedValueOnce(new Error('missing child host permission')).mockResolvedValueOnce([]);

    await injectRecorderScript(execute, 7, true);

    expect(execute).toHaveBeenNthCalledWith(1, { tabId: 7, allFrames: true });
    expect(execute).toHaveBeenNthCalledWith(2, { tabId: 7 });
  });

  it('uses only the top frame in step mode', async () => {
    const execute = vi.fn(async () => []);

    await injectRecorderScript(execute, 7);

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({ tabId: 7 });
  });
});
