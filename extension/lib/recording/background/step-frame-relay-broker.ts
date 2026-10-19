import type {
  HowbeamStepFrameResultMessage,
  StepFrameRelayAbortMessage,
  StepFrameRelayBeginMessage,
  StepFrameRelayBeginResult,
  StepFrameRelayClaimMessage,
  StepFrameRelayClaimResult,
  StepFrameRelayMutationResult,
  StepFrameRelayRejectMessage,
  StepFrameRelaySettleMessage,
} from '../../runtime/messages';

const STEP_FRAME_RELAY_AUTH_TTL_MS = 10_000;
const STEP_FRAME_RELAY_MAX_PENDING_PER_TAB = 32;

interface StepFrameRelaySender {
  tabId: number | null;
  frameId: number | null;
}

interface PendingStepFrameRelay {
  runId: string;
  captureId: string;
  tabId: number;
  originFrameId: number;
  relayToken: string;
  settleToken: string | null;
  target: { text: string; tagName: string; interactive: boolean };
  expiresAt: number;
}

export interface StepFrameRelayBrokerDependencies {
  now?: () => number;
  createToken?: () => string;
  sendResult: (
    tabId: number,
    frameId: number,
    message: HowbeamStepFrameResultMessage,
  ) => Promise<void>;
}

export interface StepFrameRelayBroker {
  begin(message: StepFrameRelayBeginMessage, sender: StepFrameRelaySender): StepFrameRelayBeginResult;
  claim(message: StepFrameRelayClaimMessage, sender: StepFrameRelaySender): StepFrameRelayClaimResult;
  reject(message: StepFrameRelayRejectMessage, sender: StepFrameRelaySender): Promise<StepFrameRelayMutationResult>;
  settle(message: StepFrameRelaySettleMessage, sender: StepFrameRelaySender): Promise<StepFrameRelayMutationResult>;
  abort(message: StepFrameRelayAbortMessage, sender: StepFrameRelaySender): StepFrameRelayMutationResult;
}

function relayKey(tabId: number, captureId: string): string {
  return `${tabId}:${captureId}`;
}

/**
 * Authorizes child-frame step relays without trusting page-visible
 * `postMessage` senders. Only an extension content script can create a pending
 * relay through runtime messaging; the opaque relay token is consumed by the
 * top-frame content script before any screenshot is requested. A fresh private
 * settle token keeps the page-visible token from confirming replay.
 */
export function createStepFrameRelayBroker(
  dependencies: StepFrameRelayBrokerDependencies,
): StepFrameRelayBroker {
  const now = dependencies.now ?? Date.now;
  const createToken = dependencies.createToken ?? (() => crypto.randomUUID());
  const pending = new Map<string, PendingStepFrameRelay>();

  const sweepExpired = () => {
    const current = now();
    for (const [key, relay] of pending) {
      if (relay.expiresAt <= current) pending.delete(key);
    }
  };

  const countPendingForTab = (tabId: number): number => {
    let count = 0;
    for (const relay of pending.values()) {
      if (relay.tabId === tabId) count += 1;
    }
    return count;
  };

  const find = (runId: string, captureId: string, sender: StepFrameRelaySender): PendingStepFrameRelay | null => {
    if (sender.tabId === null) return null;
    const relay = pending.get(relayKey(sender.tabId, captureId));
    return relay?.runId === runId ? relay : null;
  };

  const finish = async (relay: PendingStepFrameRelay, replay: boolean): Promise<void> => {
    pending.delete(relayKey(relay.tabId, relay.captureId));
    try {
      await dependencies.sendResult(relay.tabId, relay.originFrameId, {
        type: 'HOWBEAM_STEP_FRAME_RESULT',
        runId: relay.runId,
        captureId: relay.captureId,
        replay,
      });
    } catch {
      // The originating frame may have navigated or detached. Its local
      // failsafe releases the swallowed gesture if it still exists.
    }
  };

  return {
    begin(message, sender) {
      sweepExpired();
      if (sender.tabId === null || sender.frameId === null || sender.frameId <= 0) return { ok: false };
      if (countPendingForTab(sender.tabId) >= STEP_FRAME_RELAY_MAX_PENDING_PER_TAB) return { ok: false };
      const key = relayKey(sender.tabId, message.captureId);
      if (pending.has(key)) return { ok: false };

      const relayToken = createToken();
      pending.set(key, {
        runId: message.runId,
        captureId: message.captureId,
        tabId: sender.tabId,
        originFrameId: sender.frameId,
        relayToken,
        settleToken: null,
        target: {
          text: message.text,
          tagName: message.tagName,
          interactive: message.interactive,
        },
        expiresAt: now() + STEP_FRAME_RELAY_AUTH_TTL_MS,
      });
      return { ok: true, relayToken };
    },

    claim(message, sender) {
      sweepExpired();
      if (sender.frameId !== 0) return { ok: false };
      const relay = find(message.runId, message.captureId, sender);
      if (!relay || relay.settleToken !== null || relay.relayToken !== message.relayToken) return { ok: false };

      const settleToken = createToken();
      relay.relayToken = '';
      relay.settleToken = settleToken;
      relay.expiresAt = now() + STEP_FRAME_RELAY_AUTH_TTL_MS;
      return { ok: true, settleToken, target: { ...relay.target } };
    },

    async reject(message, sender) {
      sweepExpired();
      const relay = find(message.runId, message.captureId, sender);
      if (!relay || relay.settleToken !== null || relay.relayToken !== message.relayToken) return { ok: false };
      await finish(relay, false);
      return { ok: true };
    },

    async settle(message, sender) {
      sweepExpired();
      if (sender.frameId !== 0) return { ok: false };
      const relay = find(message.runId, message.captureId, sender);
      if (!relay || relay.settleToken === null || relay.settleToken !== message.settleToken) return { ok: false };
      await finish(relay, message.replay);
      return { ok: true };
    },

    abort(message, sender) {
      sweepExpired();
      const relay = find(message.runId, message.captureId, sender);
      if (!relay || sender.frameId !== relay.originFrameId) return { ok: false };
      pending.delete(relayKey(relay.tabId, relay.captureId));
      return { ok: true };
    },
  };
}
