import { discardPristineProject } from '../../storage/project-repository';
import { deleteStep, getSteps } from '../../storage/step-repository';
import { stepRole } from '../../storage/models';
import { describeBrowserError } from '../../runtime/browser-errors';
import type { RecordingState } from '../../storage/recording-state';

/**
 * 僅回收 popup 建立且仍為空白的 Project。完成與錯誤路徑仍需該 id
 * 供編輯器導頁或復原，因此予以保留。
 */
export async function reclaimAbandonedAutoCreatedProject(state: RecordingState): Promise<void> {
  if (!state.autoCreatedProjectId || state.autoCreatedProjectId !== state.sessionId) return;
  try {
    await discardPristineProject(state.autoCreatedProjectId);
  } catch (error) {
    console.error(
      '[stepmark] failed to reclaim the abandoned auto-created project:',
      describeBrowserError(error),
      error,
    );
  }
}

export async function deleteEmptySnapshotAnchor(state: RecordingState): Promise<string | null> {
  if (state.mode !== 'snapshot' || !state.sessionId || !state.groupAnchorId) return null;
  const steps = await getSteps(state.sessionId);
  const hasAnnotations = steps.some(
    (step) => step.groupId === state.groupAnchorId && stepRole(step) === 'annotation' && step.bounds !== null,
  );
  if (hasAnnotations) return null;
  await deleteStep(state.groupAnchorId);
  return state.groupAnchorId;
}

/** 停止後盡力清理；失敗可能留下孤立資料，但不可讓停止操作失敗。 */
export async function deleteEmptySnapshotAnchorBestEffort(state: RecordingState): Promise<void> {
  try {
    await deleteEmptySnapshotAnchor(state);
  } catch (cleanupError) {
    console.error(
      '[stepmark] failed to remove the empty snapshot anchor:',
      describeBrowserError(cleanupError),
      cleanupError,
    );
  }
}
