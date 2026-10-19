import { describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'test-extension',
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  },
}));

import {
  isHowbeamStepFrameResultMessage,
  isStepFrameHopPayload,
  isStepFrameRelayBeginResult,
  isStepFrameRelayClaimResult,
  isStepFrameRelayMutationResult,
  snapshotFrameScrollPingType,
  stepFrameClickMessageType,
} from '@/lib/recording/frame-relay';

describe('step frame relay protocol', () => {
  const messageType = stepFrameClickMessageType('test-extension');
  const validPayload = {
    type: messageType,
    captureId: 'capture-id',
    relayToken: 'relay-token',
    rect: { x: 10, y: 20, width: 30, height: 40 },
    originTimestamp: 1_700_000_000_000,
  };

  it('namespaces page-visible message types by extension id', () => {
    expect(stepFrameClickMessageType('a')).not.toBe(stepFrameClickMessageType('b'));
    expect(snapshotFrameScrollPingType('a')).not.toBe(snapshotFrameScrollPingType('b'));
    expect(stepFrameClickMessageType('a')).not.toBe(snapshotFrameScrollPingType('a'));
  });

  it('accepts the geometry-only public hop payload', () => {
    expect(isStepFrameHopPayload(validPayload, messageType)).toBe(true);
    expect(isStepFrameHopPayload({ ...validPayload, rect: { x: -2.5, y: 0.25, width: 1, height: 2 } }, messageType)).toBe(true);
  });

  it('rejects malformed public ids, tokens and rects', () => {
    expect(isStepFrameHopPayload(null, messageType)).toBe(false);
    expect(isStepFrameHopPayload({ ...validPayload, type: 'other' }, messageType)).toBe(false);
    expect(isStepFrameHopPayload({ ...validPayload, captureId: '' }, messageType)).toBe(false);
    expect(isStepFrameHopPayload({ ...validPayload, captureId: 'x'.repeat(129) }, messageType)).toBe(false);
    expect(isStepFrameHopPayload({ ...validPayload, relayToken: '' }, messageType)).toBe(false);
    expect(isStepFrameHopPayload({ ...validPayload, relayToken: 'x'.repeat(129) }, messageType)).toBe(false);
    expect(isStepFrameHopPayload({ ...validPayload, originTimestamp: undefined }, messageType)).toBe(false);
    expect(isStepFrameHopPayload({ ...validPayload, originTimestamp: 'now' }, messageType)).toBe(false);
    expect(isStepFrameHopPayload({ ...validPayload, originTimestamp: Number.NaN }, messageType)).toBe(false);
    for (const rect of [
      null,
      { x: Number.NaN, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: 0, height: 10 },
      { x: 0, y: 0, width: 10, height: -1 },
      { x: 2_000_000, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: 2_000_000, height: 10 },
    ]) {
      expect(isStepFrameHopPayload({ ...validPayload, rect }, messageType)).toBe(false);
    }
  });

  it('validates BEGIN responses without accepting malformed tokens', () => {
    expect(isStepFrameRelayBeginResult({ ok: true, relayToken: 'relay-token' })).toBe(true);
    expect(isStepFrameRelayBeginResult({ ok: false })).toBe(true);
    expect(isStepFrameRelayBeginResult({ ok: true, relayToken: '' })).toBe(false);
    expect(isStepFrameRelayBeginResult({ ok: true, relayToken: 'x'.repeat(129) })).toBe(false);
    expect(isStepFrameRelayBeginResult({ ok: false, relayToken: 'unexpected' })).toBe(false);
    expect(isStepFrameRelayBeginResult({ ok: 'true', relayToken: 'relay-token' })).toBe(false);
  });

  it('validates CLAIM responses and authoritative target metadata', () => {
    const valid = {
      ok: true,
      settleToken: 'settle-token',
      target: { text: 'Submit', tagName: 'button', interactive: true },
    };
    expect(isStepFrameRelayClaimResult(valid)).toBe(true);
    expect(isStepFrameRelayClaimResult({ ok: false })).toBe(true);
    expect(isStepFrameRelayClaimResult({ ...valid, settleToken: '' })).toBe(false);
    expect(isStepFrameRelayClaimResult({ ...valid, settleToken: 'x'.repeat(129) })).toBe(false);
    expect(isStepFrameRelayClaimResult({ ...valid, target: { ...valid.target, text: 'x'.repeat(201) } })).toBe(false);
    expect(isStepFrameRelayClaimResult({ ...valid, target: { ...valid.target, tagName: '' } })).toBe(false);
    expect(isStepFrameRelayClaimResult({ ...valid, target: { ...valid.target, tagName: 'x'.repeat(101) } })).toBe(false);
    expect(isStepFrameRelayClaimResult({ ...valid, target: { ...valid.target, interactive: 'yes' } })).toBe(false);
    expect(isStepFrameRelayClaimResult({ ok: false, settleToken: 'unexpected' })).toBe(false);
  });

  it('validates settlement acknowledgements and background-to-origin results', () => {
    expect(isStepFrameRelayMutationResult({ ok: true })).toBe(true);
    expect(isStepFrameRelayMutationResult({ ok: false })).toBe(true);
    expect(isStepFrameRelayMutationResult({ ok: 'true' })).toBe(false);
    expect(isStepFrameRelayMutationResult(null)).toBe(false);

    const valid = {
      type: 'HOWBEAM_STEP_FRAME_RESULT',
      runId: 'run-id',
      captureId: 'capture-id',
      replay: true,
    };
    expect(isHowbeamStepFrameResultMessage(valid)).toBe(true);
    expect(isHowbeamStepFrameResultMessage({ ...valid, replay: false })).toBe(true);
    expect(isHowbeamStepFrameResultMessage({ ...valid, type: 'other' })).toBe(false);
    expect(isHowbeamStepFrameResultMessage({ ...valid, runId: '' })).toBe(false);
    expect(isHowbeamStepFrameResultMessage({ ...valid, captureId: 'x'.repeat(129) })).toBe(false);
    expect(isHowbeamStepFrameResultMessage({ ...valid, replay: 'true' })).toBe(false);
  });
});
