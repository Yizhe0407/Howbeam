import type { Browser } from 'wxt/browser';
import type { ClickCapture } from '../../runtime/messages';
import type { Project, Step } from '../../storage/models';
import type { NewStep } from '../../storage/step-repository';
import type { PendingUndoRecord } from '../background/pending-undo-store';

/** A screenshot, decoded far enough to know its pixel scale. */
export interface Screenshot {
  blob: Blob;
  scale: number;
}

export interface CaptureRequest extends Pick<ClickCapture, 'viewport' | 'devicePixelRatio' | 'captureId'> {
  tabId: number;
  windowId: number;
}

/**
 * Everything the run flows do outside their own state, behind one interface:
 * the background wires the real browser and storage in, tests wire fakes.
 */
export interface RunPorts {
  tabs: {
    get(tabId: number): Promise<Browser.tabs.Tab>;
    /** The active tab of the window the user is in. */
    activeInCurrentWindow(): Promise<Browser.tabs.Tab | undefined>;
    activeInWindow(windowId: number): Promise<Browser.tabs.Tab | undefined>;
    focus(tabId: number, windowId?: number): Promise<void>;
    /** Sends to the tab's top frame; failures are the caller's to judge. */
    send(tabId: number, message: unknown): Promise<unknown>;
  };
  recorder: {
    /** Injects the recorder into every accessible frame of the tab. */
    inject(tabId: number): Promise<void>;
    /** Tells the tab's recorder to unmount; never throws. */
    stop(tabId: number | null): Promise<void>;
  };
  /**
   * Takes a screenshot of the window's visible tab. `guard` runs before every
   * attempt and throws to refuse; `onTaken` runs as soon as the pixels exist.
   */
  capture(request: CaptureRequest, guard: () => Promise<void>, onTaken?: () => void): Promise<Screenshot>;
  steps: {
    add(steps: readonly NewStep[], afterStepId: string | null): Promise<void>;
    get(id: string): Promise<Step | undefined>;
    outlines(sessionId: string): Promise<Step[]>;
    delete(id: string): Promise<void>;
    deleteForRun(sessionId: string, runId: string): Promise<void>;
    discardPendingAnchor(id: string): Promise<boolean>;
  };
  projects: {
    get(id: string): Promise<Project | undefined>;
    /** Deletes the Project only while it is still the empty shell a popup start created. */
    discardIfPristine(id: string): Promise<boolean>;
    /** The step a continuation inserts after, from an entry id. */
    continuationAnchor(sessionId: string, afterEntryId: string): Promise<{ afterStepId: string | null } | null>;
  };
  editor: {
    open(target: { sessionId: string; entryId: string | null }): Promise<unknown>;
  };
  undo: {
    save(record: PendingUndoRecord): Promise<void>;
    read(): Promise<PendingUndoRecord | null>;
    clear(): Promise<void>;
  };
  permissions: {
    /** Whether the run may follow the user across sites. */
    hasAllSites(): Promise<boolean>;
  };
  newId(): string;
  now(): number;
}
