import { describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: { runtime } }));

import { BACKGROUND_CONTRACTS, isBackgroundMessage, isExtensionPageOnlyMessage } from '@/lib/runtime/message-contract';
import { sendToBackground } from '@/lib/runtime/background-client';
import type { BackgroundMessageType } from '@/lib/runtime/messages';

const types = Object.keys(BACKGROUND_CONTRACTS) as BackgroundMessageType[];

describe('background message contracts', () => {
  it.each(types)('%s answers a failed handler with a reply its own sender accepts', (type) => {
    const contract = BACKGROUND_CONTRACTS[type];
    expect(contract.isResponse(contract.failure())).toBe(true);
  });

  it('refuses unknown types and inherited property names', () => {
    expect(isBackgroundMessage({ type: 'NOT_A_MESSAGE' })).toBe(false);
    expect(isBackgroundMessage({ type: 'toString' })).toBe(false);
    expect(isBackgroundMessage({ type: '__proto__' })).toBe(false);
  });

  it('gates lifecycle messages to extension pages and leaves run-bound ones to their handlers', () => {
    expect(isExtensionPageOnlyMessage({ type: 'START_RECORDING', sessionId: 'p', mode: 'steps' })).toBe(true);
    expect(isExtensionPageOnlyMessage({ type: 'OPEN_LIBRARY' })).toBe(true);
    expect(isExtensionPageOnlyMessage({ type: 'FINISH_RECORDING', runId: 'r' })).toBe(false);
    expect(isExtensionPageOnlyMessage({ type: 'CANCEL_STEP_RECAPTURE', runId: 'r' })).toBe(false);
  });
});

describe('sendToBackground', () => {
  it('returns a reply that matches the message contract', async () => {
    runtime.sendMessage.mockResolvedValueOnce({ ok: false, code: 'SOURCE_PAGE_UNREACHABLE', error: 'background.continuationSourceUnreachable' });
    await expect(sendToBackground({ type: 'START_RECORDING', sessionId: 'p', mode: 'steps' }))
      .resolves.toEqual({ ok: false, code: 'SOURCE_PAGE_UNREACHABLE', error: 'background.continuationSourceUnreachable' });
  });

  it('throws the caller\'s copy for a missing or malformed reply', async () => {
    runtime.sendMessage.mockResolvedValueOnce(undefined);
    await expect(sendToBackground({ type: 'OPEN_LIBRARY' }, '專案庫無回應')).rejects.toThrow('專案庫無回應');
    runtime.sendMessage.mockResolvedValueOnce({ ok: true, extra: 1 });
    await expect(sendToBackground({ type: 'OPEN_LIBRARY' }, '專案庫無回應')).rejects.toThrow('專案庫無回應');
  });
});
