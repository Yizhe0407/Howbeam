import type { HowbeamSnapshotMarksMessage } from '../../runtime/messages';
import type { RunPorts } from './ports';
import type { Recording } from './state';

/**
 * Sends the frozen snapshot every mark it now has, in order. The background
 * owns the marks (they are stored annotations); the page, its shield and the
 * shield's overlay only draw and dedupe from this list, so an undo, a restore
 * or a lost reply can never leave them disagreeing.
 */
export async function sendSnapshotMarks(ports: RunPorts, recording: Recording): Promise<void> {
  if (recording.mode !== 'snapshot' || !recording.anchor) return;
  const anchorId = recording.anchor.id;
  const marks = (await ports.steps.outlines(recording.sessionId))
    .filter((step) => step.groupId === anchorId && step.id !== anchorId && step.bounds !== null)
    .sort((left, right) => left.order - right.order)
    .map((step) => step.bounds!);
  const message: HowbeamSnapshotMarksMessage = { type: 'HOWBEAM_SNAPSHOT_MARKS', runId: recording.runId, marks };
  await ports.tabs.send(recording.tabId, message).catch((error) => {
    console.warn('[howbeam] the snapshot did not hear its marks', error);
  });
}
