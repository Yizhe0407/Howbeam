import { browser } from 'wxt/browser';
import { createProject, discardPristineProject, getProject } from '../storage/project-repository';
import { type Project } from '../storage/models';
import {
  clearActiveProjectId,
  getActiveProjectId,
  getRecordingState,
  setActiveProjectId,
} from '../storage/storage';
import type { OpenEditorResult, StartRecordingResult } from '../runtime/messages';
import type { RecordingMode } from '../storage/recording-state';
import {
  isOpenEditorResult,
  isStartRecordingResult,
  requireRuntimeMessageResult,
} from '../runtime/runtime-message-result';
import { t } from '@/lib/shared/i18n';

// Preserve invocation order across async IndexedDB lookups. Without this, a
// slow earlier select could overwrite a newer selection after its lookup ends.
let selectionAction: Promise<void> = Promise.resolve();

function queueSelectionAction<T>(action: () => Promise<T>): Promise<T> {
  const result = selectionAction.then(action, action);
  selectionAction = result.then(() => undefined, () => undefined);
  return result;
}

async function selectExistingProject(projectId: string): Promise<Project> {
  const project = await getProject(projectId);
  if (!project) throw new Error(t().runtime.projectNotFound);
  await setActiveProjectId(project.id);
  return project;
}

/** Selects a Project for UI navigation only. Capture ownership remains entirely
 * in RecordingState, so this operation is safe from recording-state races. */
export function selectProject(projectId: string): Promise<Project> {
  return queueSelectionAction(() => selectExistingProject(projectId));
}

export function createAndSelectProject(title?: string): Promise<Project> {
  return queueSelectionAction(async () => {
    const project = await createProject({ title });
    await setActiveProjectId(project.id);
    return project;
  });
}

/** Reads the currently selected Project, or null when nothing valid is
 * selected. Read-only; a stale selection is reported as null, not cleared. */
export async function getSelectedProject(): Promise<Project | null> {
  const selectedId = await getActiveProjectId();
  if (!selectedId) return null;
  return (await getProject(selectedId)) ?? null;
}

/**
 * UI-flow wrapper over the storage-side discardPristineProject: reclaims a Project
 * that was auto-created for a recording run which never produced anything.
 * The pristine guard and compare-and-clear of the selection live in
 * lib/storage; this wrapper only adds selection-queue ordering and the
 * restorePreviousProjectId behavior, which re-selects the pre-start selection
 * after a failed start so the aborted attempt is invisible. Callers must only
 * pass ids they themselves auto-created — an explicitly created 專案庫 project
 * shares the same empty shape and must never reach this. Returns whether it
 * deleted.
 */
export function discardUntouchedProject(
  projectId: string,
  restorePreviousProjectId: string | null = null,
): Promise<boolean> {
  return queueSelectionAction(async () => {
    const deleted = await discardPristineProject(projectId);
    if (!deleted) return false;
    if (restorePreviousProjectId && restorePreviousProjectId !== projectId) {
      const previous = await getProject(restorePreviousProjectId);
      if (previous) await setActiveProjectId(previous.id);
    }
    return true;
  });
}

/** The Project a run records into, claimed before START_RECORDING is sent. */
export interface RecordingProjectClaim {
  project: Project;
  /** True when the claim created the Project, so an empty run may reclaim it. */
  autoCreated: boolean;
  /** Undoes the claim after a start that never produced a live run: reclaims
   * an auto-created shell, or puts the pre-claim selection back. */
  release: () => Promise<void>;
}

function restoreSelection(previousProjectId: string | null, claimedProjectId: string): Promise<void> {
  return queueSelectionAction(async () => {
    if (previousProjectId === claimedProjectId) return;
    const previous = previousProjectId ? await getProject(previousProjectId) : undefined;
    if (previous) await setActiveProjectId(previous.id);
    else await clearActiveProjectId(claimedProjectId);
  });
}

/**
 * Picks the Project a popup-initiated run records into and makes it the UI
 * selection. `null` creates a brand-new Project; an id appends to that existing
 * one (the same append the editor's 接續錄製 performs). Shared by the popup
 * and the background's permission-resumed start so both resolve a target the
 * same way.
 */
export async function claimRecordingProject(targetProjectId: string | null): Promise<RecordingProjectClaim> {
  // The pre-claim selection is remembered so a failed start is invisible.
  const previousProjectId = (await getSelectedProject())?.id ?? null;
  if (targetProjectId === null) {
    const project = await createAndSelectProject();
    return {
      project,
      autoCreated: true,
      release: async () => {
        await discardUntouchedProject(project.id, previousProjectId);
      },
    };
  }
  const project = await selectProject(targetProjectId);
  return { project, autoCreated: false, release: () => restoreSelection(previousProjectId, project.id) };
}

/**
 * The popup's start transaction. By default every start records into a
 * brand-new Project (Scribe/Tango convention); passing `targetProjectId` is the
 * explicit opt-in to append to an existing one. Claims the Project, asks the
 * background to start recording into it, and on failure rolls the world back
 * to exactly how it was. Returns the Project the live run records into.
 */
export async function startRecordingIntoProject(
  mode: RecordingMode,
  targetProjectId: string | null = null,
): Promise<Project> {
  const claim = await claimRecordingProject(targetProjectId);
  const { project } = claim;
  try {
    const result = requireRuntimeMessageResult<StartRecordingResult>(
      await browser.runtime.sendMessage({
        type: 'START_RECORDING',
        sessionId: project.id,
        mode,
        ...(claim.autoCreated ? { autoCreatedProject: true } : {}),
      }),
      isStartRecordingResult,
      t().runtime.recordingServiceUnavailable,
    );
    if (!result.ok) throw new Error(result.error);
    return project;
  } catch (startError) {
    // Best-effort rollback of the claim above. The recording-state probe
    // covers the odd case where the run actually started but the response was
    // lost — releasing a live run's Project would strand it.
    try {
      const live = await getRecordingState();
      if (!(live.isRecording && live.sessionId === project.id)) await claim.release();
    } catch (rollbackError) {
      console.error('[howbeam] failed to roll back the recording project claim', rollbackError);
    }
    throw startError;
  }
}

/** Explicit UI-flow helper for editor navigation with no valid selection
 * (popup 開啟編輯器). Recording starts never use this — the popup's 開始錄製
 * always records into a fresh Project via createAndSelectProject, and appending
 * to an existing Project is exclusively the editor's 接續錄製 flow. Passive
 * startup/recovery code must use getActiveProjectId instead. A stale id is
 * cleared and replaced with a fresh Project; it is never recreated via
 * ensureProject, which could resurrect a permanently deleted Project. */
export function ensureSelectedProject(): Promise<Project> {
  return queueSelectionAction(async () => {
    const selectedId = await getActiveProjectId();
    if (selectedId) {
      const selected = await getProject(selectedId);
      if (selected) return selected;
      await clearActiveProjectId(selectedId);
    }

    const project = await createProject();
    await setActiveProjectId(project.id);
    return project;
  });
}

/**
 * Selects a Project and opens it in the single editor tab. With `inPlace`, an
 * extension page asks to become the editor itself when no editor is open
 * elsewhere; an existing editor tab always takes precedence.
 */
export async function openSelectedProjectInEditor(projectId: string, options: { inPlace?: boolean } = {}): Promise<void> {
  const project = await selectProject(projectId);
  const result = requireRuntimeMessageResult<OpenEditorResult>(
    await browser.runtime.sendMessage({
      type: 'OPEN_EDITOR',
      sessionId: project.id,
      ...(options.inPlace ? { inPlace: true } : {}),
    }),
    isOpenEditorResult,
    t().popup.editorServiceUnavailable,
  );
  if (!result.ok) throw new Error(result.error);
}

/** Compare-and-clears only the matching UI selection. It deliberately does
 * not inspect or rewrite RecordingState; the global operation lock protects
 * Project data mutations, not harmless navigation state. */
export function clearSelectedProject(projectId: string): Promise<void> {
  return queueSelectionAction(async () => {
    await clearActiveProjectId(projectId);
  });
}
