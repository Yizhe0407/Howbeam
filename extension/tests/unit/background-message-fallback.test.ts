import { afterEach, describe, expect, it, vi } from 'vitest';
import { withMessageFailureFallback } from '@/lib/runtime/background-message-fallback';

describe('withMessageFailureFallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('回傳成功操作的結果', async () => {
    await expect(withMessageFailureFallback(Promise.resolve({ ok: true }), '成功操作', { ok: false }))
      .resolves.toEqual({ ok: true });
  });

  it('記錄失敗並將 rejected promise 轉為 fallback', async () => {
    const error = new Error('channel closed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(withMessageFailureFallback(Promise.reject(error), '訊息處理失敗', { ok: false }))
      .resolves.toEqual({ ok: false });
    expect(consoleError).toHaveBeenCalledWith(
      '[howbeam] 訊息處理失敗:',
      'Error: channel closed',
      error,
    );
  });
});
