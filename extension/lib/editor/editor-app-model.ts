import type { StepRecaptureTarget } from '../storage/recording-state';
import { type StepEntry } from '../storage/models';
import type { ProjectStructureMutationResult } from '../storage/project-structure';

export const EMPTY_STEP_ENTRIES: StepEntry[] = [];

export interface UndoAction {
  id: number;
  message: string;
  projectId: string;
  expectedRevision: number;
  restoreSelectionId?: string;
  /** Puts the Project back and returns the structure that commit left, to show at once. */
  restore: () => Promise<ProjectStructureMutationResult>;
  /** Message of the earlier undo this one replaced. Only one undo is offered at
   * a time, so that earlier action is now final and the snackbar says so. */
  supersedes?: string;
}

/** What a mutation describes about its own undo. The editor controller owns the
 * sequence number, the project it belongs to and what it supersedes, so a
 * mutation never supplies any of them. */
export type PendingUndoAction = Omit<UndoAction, 'id' | 'projectId' | 'supersedes'>;

type PreparedCaptureSource =
  /** `sourceUrl` is the background-resolved persisted URL. The elsewhere tab
   * picker only compares it against candidate tab URLs (to skip preselecting
   * the page the user just recorded); it is never sent anywhere. */
  | { kind: 'origin'; sourceOrigin: string; permissionPattern: string; sourceUrl: string }
  /** The Project has no recorded source page (no steps), so the confirmation
   * dialog can only offer the site-agnostic elsewhere continuation. Only a
   * continuation action may carry this: recapture always targets a stored
   * step and therefore always has an origin. */
  | { kind: 'unavailable'; reason: string };

/** One open, recordable tab offered by the 改在其他頁面接續 picker. */
export interface ContinuationTabOption {
  id: number;
  windowId: number;
  title: string;
  url: string;
  favIconUrl?: string;
}

export type PreparedCapturePermission = {
  source: PreparedCaptureSource;
  /** The entry the grant is bound to, so changing the selection cancels it.
   * Continuation records into the Project as a whole and has no such anchor. */
  entryId: string | null;
  action:
    | { kind: 'recapture'; target: StepRecaptureTarget }
    | { kind: 'continuation' };
};

export function equalIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}


/** The Project can't be changed right now (it is gone, being recorded, or held by a permission flow). */
export class EditingBlockedError extends Error {
  constructor() {
    super('The project cannot be changed right now.');
    this.name = 'EditingBlockedError';
  }
}

/** What a queued edit will do to the entry list, shown on top of the stored entries until it settles. */
export type OptimisticChange = (entries: StepEntry[]) => StepEntry[];
