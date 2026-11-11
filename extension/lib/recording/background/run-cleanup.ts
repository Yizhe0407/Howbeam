import { discardPristineProject } from '../../storage/project-repository';
import { discardPendingAnchor } from '../../storage/step-repository';
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
      '[howbeam] failed to reclaim the abandoned auto-created project:',
      describeBrowserError(error),
      error,
    );
  }
}

/** Discards the run's snapshot base image if no annotation was ever added to it. */
export async function deleteEmptySnapshotAnchor(state: RecordingState): Promise<void> {
  if (state.mode !== 'snapshot' || !state.groupAnchorId) return;
  await discardPendingAnchor(state.groupAnchorId);
}

/** 停止後盡力清理；失敗可能留下孤立資料，但不可讓停止操作失敗。 */
export async function deleteEmptySnapshotAnchorBestEffort(state: RecordingState): Promise<void> {
  try {
    await deleteEmptySnapshotAnchor(state);
  } catch (cleanupError) {
    console.error(
      '[howbeam] failed to remove the empty snapshot anchor:',
      describeBrowserError(cleanupError),
      cleanupError,
    );
  }
}
