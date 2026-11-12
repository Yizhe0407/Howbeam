import { describe, expect, it } from 'vitest';
import type { Step } from '@/lib/storage/models';
import { sendSnapshotMarks } from '@/lib/recording/run/snapshot-marks';
import { startingRun } from '@/lib/recording/run/transitions';
import { fakePorts } from './fakes';

function snapshotRecording() {
  return {
    ...startingRun({
      runId: 'run-1',
      sessionId: 'project-1',
      tabId: 7,
      mode: 'snapshot' as const,
      newProject: false,
      targetProjectTitle: null,
      insertAfterStepId: null,
    }),
    phase: 'recording' as const,
    anchor: { id: 'anchor-1', viewport: null, devicePixelRatio: null },
  };
}

function step(id: string, order: number, overrides: Partial<Step> = {}): Step {
  return {
    id,
    sessionId: 'project-1',
    order,
    bounds: { x: order * 10, y: 0, width: 5, height: 5 },
    devicePixelRatio: 1,
    description: '',
    url: 'https://site.example/page',
    timestamp: order,
    ...overrides,
  };
}

describe('snapshot marks', () => {
  it('sends the snapshot every stored mark of its base image, in order', async () => {
    const { ports, steps } = fakePorts();
    steps.push(
      step('anchor-1', 0, { groupId: 'anchor-1', bounds: null }),
      step('mark-2', 2, { groupId: 'anchor-1' }),
      step('mark-1', 1, { groupId: 'anchor-1' }),
      step('other-snapshot', 3, { groupId: 'anchor-0' }),
    );

    await sendSnapshotMarks(ports, snapshotRecording());

    expect(ports.tabs.send).toHaveBeenCalledWith(7, {
      type: 'HOWBEAM_SNAPSHOT_MARKS',
      runId: 'run-1',
      marks: [
        { x: 10, y: 0, width: 5, height: 5 },
        { x: 20, y: 0, width: 5, height: 5 },
      ],
    });
  });

  it('sends nothing for a step run or a snapshot without a base image', async () => {
    const { ports } = fakePorts();
    await sendSnapshotMarks(ports, { ...snapshotRecording(), mode: 'steps' });
    await sendSnapshotMarks(ports, { ...snapshotRecording(), anchor: null });
    expect(ports.tabs.send).not.toHaveBeenCalled();
  });
});
