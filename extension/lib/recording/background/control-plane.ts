import { RecorderReadyGate, type RecorderIdentity } from '../recorder-ready';
import { queueStateMutation } from '../background-queues';
import { getRecordingState, setRecordingState } from '../../storage/storage';
import type { BackgroundMessage } from '../../runtime/messages';
import type { RecordingState } from '../../storage/recording-state';

/** How long a startup waits for the injected recorder's READY handshake. */
const RECORDER_READY_TIMEOUT_MS = 5_000;

/** The viewport/url/timestamp context a snapshot recorder reports alongside
 * its READY handshake; the anchor capture consumes it during startup. */
export type SnapshotCaptureContext = NonNullable<
  Extract<BackgroundMessage, { type: 'STEPMARK_READY' }>['snapshotContext']
>;

export interface ClaimControlOptions {
  /** Cancel and clear the recorder startup gate. */
  cancelRecorderGate?: boolean;
  /** Cancel and clear the recapture startup gate. */
  cancelRecaptureGate?: boolean;
  /** Drop a snapshot capture context left behind by a previous startup. */
  clearSnapshotContext?: boolean;
  /** Invalidate the undo window (and lazily its persisted copy). */
  discardUndo?: boolean;
  /** Set false when the caller already bumped the version (e.g. inside an
   * earlier queued state mutation) and only needs the gates cleared. */
  bumpVersion?: boolean;
}

export type ConditionalStateWrite = { previous: RecordingState; next: RecordingState };

export interface RecorderReadyStartup<T> {
  /** Which pending-gate slot this startup owns. */
  slot: 'pendingRecorderReady' | 'pendingRecaptureReady';
  identity: RecorderIdentity;
  /** Injection racing the gate; both must settle before `ready` runs. */
  inject(): Promise<unknown>;
  /** Error thrown when the recorder never reported READY before the timeout. */
  notReadyError(): Error;
  /** Post-handshake body. For recorder startups it runs while the pending
   * snapshot context delivered by the handshake is still available. */
  ready(): Promise<T>;
}

export interface ControlPlaneHooks {
  /** Invalidates the undo window synchronously; the plane never touches the
   * undo storage itself. */
  discardPendingUndo(): void;
}

/**
 * The single owner of the background's in-memory control state: the control
 * version, the click gate, the two recorder-ready gates and the pending
 * snapshot context. Control messages invalidate work synchronously, before
 * their first await — claimControl is that contract's one enforcement point —
 * while the persisted runId provides the same protection across
 * service-worker restarts.
 */
export function createControlPlane(hooks: ControlPlaneHooks) {
  const plane = {
    controlVersion: 0,
    acceptingClicks: true,
    pendingRecorderReady: null as RecorderReadyGate | null,
    pendingRecaptureReady: null as RecorderReadyGate | null,
    pendingSnapshotContext: undefined as SnapshotCaptureContext | undefined,
    /** Settles when the recorder startup in flight, if any, has finished. */
    startupSettled: null as Promise<void> | null,
    /** The tab a run is moving out of while the move is in flight. */
    followOriginTabId: null as number | null,

    bumpVersion(): number {
      return ++plane.controlVersion;
    },

    /**
     * Claims control of the capture machinery synchronously so all in-flight
     * async work observes the change and cancels itself; the bumped version is
     * the durable half of that contract. Each caller names exactly the gates
     * it owns: clearing a gate another flow still needs would cancel that
     * flow's startup.
     */
    claimControl(options: ClaimControlOptions): number {
      plane.acceptingClicks = false;
      if (options.cancelRecorderGate) {
        plane.pendingRecorderReady?.cancel();
        plane.pendingRecorderReady = null;
      }
      if (options.cancelRecaptureGate) {
        plane.pendingRecaptureReady?.cancel();
        plane.pendingRecaptureReady = null;
      }
      if (options.clearSnapshotContext) plane.pendingSnapshotContext = undefined;
      if (options.discardUndo) hooks.discardPendingUndo();
      return options.bumpVersion === false ? plane.controlVersion : plane.bumpVersion();
    },

    /**
     * The shared recorder-startup ritual: publishes a fresh ready gate in the
     * named slot, awaits the injection and the READY handshake together,
     * throws the caller's error when the recorder never became ready, and
     * runs `ready` while the gate is still live. The finally leg always
     * retires the gate — the slot is cleared only while this gate still owns
     * it, a recorder startup drops the pending snapshot context its handshake
     * delivered, and the gate's timer is cancelled.
     */
    async withRecorderReadyGate<T>(startup: RecorderReadyStartup<T>): Promise<T> {
      const readyGate = new RecorderReadyGate(startup.identity, RECORDER_READY_TIMEOUT_MS);
      plane[startup.slot] = readyGate;
      const run = (async () => {
        try {
          const [, recorderReady] = await Promise.all([startup.inject(), readyGate.promise]);
          if (!recorderReady) throw startup.notReadyError();
          return await startup.ready();
        } finally {
          if (plane[startup.slot] === readyGate) plane[startup.slot] = null;
          if (startup.slot === 'pendingRecorderReady') plane.pendingSnapshotContext = undefined;
          readyGate.cancel();
        }
      })();
      const settled = run.then(() => undefined, () => undefined);
      plane.startupSettled = settled;
      void settled.then(() => {
        if (plane.startupSettled === settled) plane.startupSettled = null;
      });
      return run;
    },

    /**
     * Serialized compare-then-write against the recording state: `update`
     * applies only when the control version still matches (checked again after
     * the read, because a control message may claim control while the read is
     * in flight) and `predicate` accepts the freshly read state. Pass a null
     * version for writes guarded by their predicate alone.
     */
    async writeStateIf(
      version: number | null,
      predicate: (current: RecordingState) => boolean,
      update: (current: RecordingState) => RecordingState,
    ): Promise<ConditionalStateWrite | null> {
      return queueStateMutation(async () => {
        if (version != null && version !== plane.controlVersion) return null;
        const current = await getRecordingState();
        if ((version != null && version !== plane.controlVersion) || !predicate(current)) return null;
        const next = update(current);
        await setRecordingState(next);
        return { previous: current, next };
      });
    },

    async writeStateForControl(
      version: number,
      update: (current: RecordingState) => RecordingState,
    ): Promise<RecordingState | null> {
      return (await plane.writeStateIf(version, () => true, update))?.next ?? null;
    },
  };
  return plane;
}

export type ControlPlane = ReturnType<typeof createControlPlane>;
