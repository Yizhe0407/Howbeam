import type { RecordingControlMessage, RecordingControlResult } from '../runtime/messages';
import type { RecordingMode, RecordingPhase } from '../storage/recording-state';
import type { CopyKey } from '../shared/i18n/copy';

/**
 * What the recorder needs from the in-page recording toolbar. The toolbar
 * itself is React UI in components/recording; the content script's entrypoint
 * hands its mount function to the recorder, so lib/ never imports UI.
 */
export interface RecordingToolbarState {
  runId: string;
  mode: RecordingMode;
  phase: RecordingPhase;
  itemCount: number;
  runItemCount: number;
  /** Existing Project the run appends to; null when recording into a new one. */
  projectTitle?: string | null;
  error: CopyKey | null;
}

type ToolbarAction = RecordingControlMessage['type'];

export interface ToolbarMountOptions {
  onCommand: (action: ToolbarAction, undoToken?: string) => Promise<RecordingControlResult>;
  onUndoApplied?: () => void;
  onRestoreApplied?: () => void;
  onStartRegionCapture?: () => void;
}

export interface MountedRecordingToolbar {
  host: HTMLElement;
  update(state: RecordingToolbarState): void;
  setRegionCaptureActive(active: boolean): void;
  /** Shows a page-side problem on the toolbar; transient notices clear
   * themselves, a persistent one stays until replaced or cleared with null. */
  showNotice(notice: string | null, options?: { persistent?: boolean }): void;
  remove(): void;
}

export type MountRecordingToolbar = (
  initialState: RecordingToolbarState,
  options: ToolbarMountOptions,
) => MountedRecordingToolbar;
