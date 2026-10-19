import { describe, expect, it } from 'vitest';
import { createStepFrameRelayBroker } from '@/lib/recording/background/step-frame-relay-broker';
import type {
  HowbeamStepFrameResultMessage,
  StepFrameRelayAbortMessage,
  StepFrameRelayBeginMessage,
  StepFrameRelayClaimMessage,
  StepFrameRelayRejectMessage,
  StepFrameRelaySettleMessage,
} from '@/lib/runtime/messages';

const beginMessage: StepFrameRelayBeginMessage = {
  type: 'HOWBEAM_STEP_FRAME_BEGIN',
  runId: 'run-1',
  captureId: 'capture-1',
  rect: { x: 12.5, y: -4, width: 160, height: 48 },
  text: 'Open settings',
  tagName: 'BUTTON',
  interactive: true,
};

const childSender = { tabId: 7, frameId: 3 };
const topSender = { tabId: 7, frameId: 0 };

function claimMessage(relayToken: string): StepFrameRelayClaimMessage {
  return {
    type: 'HOWBEAM_STEP_FRAME_CLAIM',
    runId: beginMessage.runId,
    captureId: beginMessage.captureId,
    relayToken,
  };
}

function rejectMessage(relayToken: string): StepFrameRelayRejectMessage {
  return {
    type: 'HOWBEAM_STEP_FRAME_REJECT',
    runId: beginMessage.runId,
    captureId: beginMessage.captureId,
    relayToken,
  };
}

function settleMessage(settleToken: string, replay = true): StepFrameRelaySettleMessage {
  return {
    type: 'HOWBEAM_STEP_FRAME_SETTLE',
    runId: beginMessage.runId,
    captureId: beginMessage.captureId,
    settleToken,
    replay,
  };
}

const abortMessage: StepFrameRelayAbortMessage = {
  type: 'HOWBEAM_STEP_FRAME_ABORT',
  runId: beginMessage.runId,
  captureId: beginMessage.captureId,
};

interface SentResult {
  tabId: number;
  frameId: number;
  message: HowbeamStepFrameResultMessage;
}

function createHarness(tokens: string[]) {
  let currentTime = 1_000;
  let tokenIndex = 0;
  const sentResults: SentResult[] = [];
  const broker = createStepFrameRelayBroker({
    now: () => currentTime,
    createToken: () => {
      const token = tokens[tokenIndex];
      tokenIndex += 1;
      if (token === undefined) throw new Error('Unexpected token request');
      return token;
    },
    sendResult: async (tabId, frameId, message) => {
      sentResults.push({ tabId, frameId, message });
    },
  });

  return {
    broker,
    sentResults,
    advanceTime(milliseconds: number) {
      currentTime += milliseconds;
    },
  };
}

describe('step frame relay broker', () => {
  it('accepts begin only from a child frame and lets the top frame claim authoritative target metadata', () => {
    const { broker } = createHarness(['relay-token', 'settle-token']);

    expect(broker.begin(beginMessage, topSender)).toEqual({ ok: false });
    expect(broker.begin(beginMessage, childSender)).toEqual({
      ok: true,
      relayToken: 'relay-token',
    });
    expect(broker.claim(claimMessage('relay-token'), topSender)).toEqual({
      ok: true,
      settleToken: 'settle-token',
      target: {
        text: beginMessage.text,
        tagName: beginMessage.tagName,
        interactive: beginMessage.interactive,
      },
    });
  });

  it('does not consume authorization when claim uses the wrong token, frame, or tab', () => {
    const { broker } = createHarness(['relay-token', 'settle-token']);
    expect(broker.begin(beginMessage, childSender)).toEqual({ ok: true, relayToken: 'relay-token' });

    expect(broker.claim(claimMessage('forged-token'), topSender)).toEqual({ ok: false });
    expect(broker.claim(claimMessage('relay-token'), childSender)).toEqual({ ok: false });
    expect(broker.claim(claimMessage('relay-token'), { tabId: 8, frameId: 0 })).toEqual({ ok: false });
    expect(broker.claim(claimMessage('relay-token'), topSender)).toMatchObject({
      ok: true,
      settleToken: 'settle-token',
    });
  });

  it('allows the page-visible relay token to be claimed only once', () => {
    const { broker } = createHarness(['relay-token', 'settle-token']);
    expect(broker.begin(beginMessage, childSender)).toEqual({ ok: true, relayToken: 'relay-token' });

    expect(broker.claim(claimMessage('relay-token'), topSender)).toMatchObject({ ok: true });
    expect(broker.claim(claimMessage('relay-token'), topSender)).toEqual({ ok: false });
  });

  it('rotates to a private settle token and rejects the old token or a non-top/wrong-tab sender', async () => {
    const { broker, sentResults } = createHarness(['relay-token', 'settle-token']);
    expect(broker.begin(beginMessage, childSender)).toEqual({ ok: true, relayToken: 'relay-token' });
    const claim = broker.claim(claimMessage('relay-token'), topSender);
    if (!claim.ok) throw new Error('Expected relay claim to succeed');

    expect(claim.settleToken).toBe('settle-token');
    expect(claim.settleToken).not.toBe('relay-token');
    expect(await broker.settle(settleMessage('relay-token'), topSender)).toEqual({ ok: false });
    expect(await broker.settle(settleMessage(claim.settleToken), childSender)).toEqual({ ok: false });
    expect(await broker.settle(settleMessage(claim.settleToken), { tabId: 8, frameId: 0 })).toEqual({ ok: false });
    expect(sentResults).toEqual([]);

    expect(await broker.settle(settleMessage(claim.settleToken), topSender)).toEqual({ ok: true });
    expect(await broker.settle(settleMessage(claim.settleToken), topSender)).toEqual({ ok: false });
  });

  it('settles by delivering exactly one result to the originating child frame', async () => {
    const originSender = { tabId: 23, frameId: 17 };
    const claimant = { tabId: 23, frameId: 0 };
    const { broker, sentResults } = createHarness(['relay-token', 'settle-token']);
    expect(broker.begin(beginMessage, originSender)).toEqual({ ok: true, relayToken: 'relay-token' });
    const claim = broker.claim(claimMessage('relay-token'), claimant);
    if (!claim.ok) throw new Error('Expected relay claim to succeed');

    expect(await broker.settle(settleMessage(claim.settleToken, true), claimant)).toEqual({ ok: true });
    expect(sentResults).toEqual([
      {
        tabId: originSender.tabId,
        frameId: originSender.frameId,
        message: {
          type: 'HOWBEAM_STEP_FRAME_RESULT',
          runId: beginMessage.runId,
          captureId: beginMessage.captureId,
          replay: true,
        },
      },
    ]);
  });

  it('rejects an unclaimed relay, reports replay false to the origin, and invalidates it', async () => {
    const originSender = { tabId: 7, frameId: 11 };
    const { broker, sentResults } = createHarness(['relay-token']);
    expect(broker.begin(beginMessage, originSender)).toEqual({ ok: true, relayToken: 'relay-token' });

    expect(await broker.reject(rejectMessage('wrong-token'), { tabId: 7, frameId: 4 })).toEqual({ ok: false });
    expect(await broker.reject(rejectMessage('relay-token'), { tabId: 7, frameId: 4 })).toEqual({ ok: true });
    expect(sentResults).toEqual([
      {
        tabId: originSender.tabId,
        frameId: originSender.frameId,
        message: {
          type: 'HOWBEAM_STEP_FRAME_RESULT',
          runId: beginMessage.runId,
          captureId: beginMessage.captureId,
          replay: false,
        },
      },
    ]);
    expect(broker.claim(claimMessage('relay-token'), { tabId: 7, frameId: 0 })).toEqual({ ok: false });
  });

  it('allows only the origin frame to abort and removes the relay without sending a result', () => {
    const originSender = { tabId: 7, frameId: 9 };
    const { broker, sentResults } = createHarness(['relay-token']);
    expect(broker.begin(beginMessage, originSender)).toEqual({ ok: true, relayToken: 'relay-token' });

    expect(broker.abort(abortMessage, { tabId: 8, frameId: 9 })).toEqual({ ok: false });
    expect(broker.abort(abortMessage, { tabId: 7, frameId: 8 })).toEqual({ ok: false });
    expect(broker.abort(abortMessage, originSender)).toEqual({ ok: true });
    expect(sentResults).toEqual([]);
    expect(broker.claim(claimMessage('relay-token'), topSender)).toEqual({ ok: false });
  });

  it('expires both unclaimed relay tokens and rotated settle tokens after ten seconds', async () => {
    const unclaimed = createHarness(['relay-token-1', 'relay-token-2']);
    expect(unclaimed.broker.begin(beginMessage, childSender)).toEqual({
      ok: true,
      relayToken: 'relay-token-1',
    });
    unclaimed.advanceTime(10_000);
    expect(unclaimed.broker.claim(claimMessage('relay-token-1'), topSender)).toEqual({ ok: false });
    expect(unclaimed.broker.begin(beginMessage, childSender)).toEqual({
      ok: true,
      relayToken: 'relay-token-2',
    });

    const claimed = createHarness(['relay-token', 'settle-token']);
    expect(claimed.broker.begin(beginMessage, childSender)).toEqual({ ok: true, relayToken: 'relay-token' });
    const claim = claimed.broker.claim(claimMessage('relay-token'), topSender);
    if (!claim.ok) throw new Error('Expected relay claim to succeed');
    claimed.advanceTime(10_000);

    expect(await claimed.broker.settle(settleMessage(claim.settleToken), topSender)).toEqual({ ok: false });
    expect(claimed.sentResults).toEqual([]);
  });
});
