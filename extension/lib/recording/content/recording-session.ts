import type { RegionCapture } from '../../capture/region-capture';
import type { StepGestureQueue } from '../../capture/step-gesture-queue';
import type { MountedRecordingToolbar } from '../recording-toolbar-host';
import type { SnapshotShield } from '../snapshot-shield';
import type { StepHoverPreview } from '../step-hover-preview';
import type { BackgroundTransport } from '../../runtime/background-client';

/**
 * Mutable handles one content-script recording run shares between the
 * entrypoint's lifecycle spine and the per-mode recorders — teardown, the
 * state subscription, shield callbacks and the recorders all need the same
 * shield, toolbar, hover preview and gesture queue. Recorders publish the
 * instances they create here; only the entrypoint's cleanup disposes of them.
 */
export interface ContentRecordingSession {
  readonly runId: string;
  /** Requests to the background, over the recorder's connection. */
  readonly send: BackgroundTransport;
  /** True while the run is paused; recorders read it to drop input. */
  paused: boolean;
  shield: SnapshotShield | null;
  regionCapture: RegionCapture | null;
  toolbar: MountedRecordingToolbar | null;
  hoverPreview: StepHoverPreview | null;
  gestureQueue: StepGestureQueue | null;
}

export function createContentRecordingSession(options: {
  runId: string;
  paused: boolean;
  send: BackgroundTransport;
}): ContentRecordingSession {
  return {
    runId: options.runId,
    send: options.send,
    paused: options.paused,
    shield: null,
    regionCapture: null,
    toolbar: null,
    hoverPreview: null,
    gestureQueue: null,
  };
}
