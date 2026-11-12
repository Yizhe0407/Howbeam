import type { Browser } from 'wxt/browser';
import type { StartRecordingMessage, StartRecordingResult } from '../../runtime/messages';
import { createRunActor, type RunStore } from './actor';
import { createCapture, type Capture } from './capture';
import { createLifecycle } from './lifecycle';
import { createNavigation } from './navigation';
import type { RunPorts } from './ports';
import { createRecapture, type RecaptureSources } from './recapture';
import { createRecorderGate } from './recorder-gate';
import { createRecovery } from './recovery';
import { createSnapshotControls } from './snapshot';
import { createUndo } from './undo';
import { editorOpenFailed, editorRecovered, needsEditorRecovery } from './transitions';

export interface RunOptions {
  store: RunStore;
  ports: RunPorts;
  sources: RecaptureSources;
  extensionOrigin: string;
  resolveContinuationTab(
    message: StartRecordingMessage,
    sender: Browser.runtime.MessageSender,
  ): Promise<{ ok: true; tab: Browser.tabs.Tab } | Extract<StartRecordingResult, { ok: false }>>;
  discardPendingAnchorsExcept(keep: string | null): Promise<unknown>;
}

/** The recording and recapture operations, on one actor. */
export function createRun(options: RunOptions) {
  const { ports } = options;
  const actor = createRunActor(options.store);
  const recordingGate = createRecorderGate();
  const undo = createUndo({ actor, ports });
  const recapture = createRecapture({
    actor,
    ports,
    gate: createRecorderGate(),
    sources: options.sources,
    discardUndo: undo.discard,
  });
  // Lifecycle, capture and navigation call each other; each is bound once all exist.
  let capture: Capture | null = null;
  let navigation: ReturnType<typeof createNavigation> | null = null;
  const lifecycle = createLifecycle({
    actor,
    ports,
    gate: recordingGate,
    extensionOrigin: options.extensionOrigin,
    captureAnchor: (...args) => capture!.captureAnchor(...args),
    discardUndo: undo.discard,
    isRecaptureStarting: recapture.isStarting,
    resolveContinuationTab: options.resolveContinuationTab,
    continueAfterTabClosed: (...args) => navigation!.continueAfterTabClosed(...args),
  });
  navigation = createNavigation({ actor, ports, lifecycle });
  capture = createCapture({ actor, ports, gate: recordingGate, lifecycle, discardUndo: undo.discard });
  const snapshot = createSnapshotControls({ actor, ports, lifecycle, capture, discardUndo: undo.discard });
  const recovery = createRecovery({
    actor,
    ports,
    lifecycle,
    navigation,
    discardPendingAnchorsExcept: options.discardPendingAnchorsExcept,
  });

  /** The ended run's claim on the editor, for the editor opener. */
  const editorRecovery = {
    async current() {
      await actor.ready();
      const op = actor.state().operation;
      const sessionId = op.kind === 'recapture' ? op.context.sessionId : op.sessionId;
      return { sessionId, needsRecovery: needsEditorRecovery(actor.state()) };
    },
    async settle(sessionId: string, outcome: 'opened' | 'failed') {
      await actor
        .run((ctx) =>
          ctx.commit((state) => {
            if (state.operation.kind !== 'idle' || state.operation.sessionId !== sessionId) return state;
            return outcome === 'opened' ? editorRecovered(state) : editorOpenFailed(state);
          }),
        )
        .catch(() => {});
    },
  };

  return { actor, lifecycle, capture, navigation, snapshot, undo, recapture, recovery, editorRecovery };
}

export type Run = ReturnType<typeof createRun>;
