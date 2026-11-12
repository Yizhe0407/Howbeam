import { sendToBackground } from '../runtime/background-client';
import { createProject, getProject } from '../storage/project-repository';
import { type Project } from '../storage/models';
import { clearActiveProjectId, getActiveProjectId, setActiveProjectId } from '../storage/storage';
import type { RecordingMode } from '../storage/recording-state';
import { t } from '@/lib/shared/i18n';
import { copyText } from '@/lib/shared/i18n/copy';
import { UserMessageError } from '@/lib/shared/user-message-error';

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
  if (!project) throw new UserMessageError(t().runtime.projectNotFound);
  await setActiveProjectId(project.id);
  return project;
}

/** Selects a Project for UI navigation only. Capture ownership remains entirely
 * in RecordingState, so this operation is safe from recording-state races. */
export function selectProject(projectId: string): Promise<Project> {
  return queueSelectionAction(() => selectExistingProject(projectId));
}

/** Reads the currently selected Project, or null when nothing valid is
 * selected. Read-only; a stale selection is reported as null, not cleared. */
export async function getSelectedProject(): Promise<Project | null> {
  const selectedId = await getActiveProjectId();
  if (!selectedId) return null;
  return (await getProject(selectedId)) ?? null;
}

/**
 * The popup's start. By default a run records into a Project of its own,
 * which the background creates when the first capture is stored; passing
 * `targetProjectId` appends to an existing Project instead. The background
 * owns the whole start, so there is nothing to roll back here.
 */
export async function startRecording(mode: RecordingMode, targetProjectId: string | null = null): Promise<void> {
  const result = await sendToBackground({
    type: 'START_RECORDING',
    target: targetProjectId ? { kind: 'project', projectId: targetProjectId } : { kind: 'new' },
    mode,
  }, t().runtime.recordingServiceUnavailable);
  if (!result.ok) throw new UserMessageError(copyText(result.error));
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
  const result = await sendToBackground({
    type: 'OPEN_EDITOR',
    sessionId: project.id,
    ...(options.inPlace ? { inPlace: true } : {}),
  }, t().popup.editorServiceUnavailable);
  if (!result.ok) throw new UserMessageError(copyText(result.error));
}

/** Compare-and-clears only the matching UI selection. It deliberately does
 * not inspect or rewrite RecordingState; the global operation lock protects
 * Project data mutations, not harmless navigation state. */
export function clearSelectedProject(projectId: string): Promise<void> {
  return queueSelectionAction(async () => {
    await clearActiveProjectId(projectId);
  });
}
