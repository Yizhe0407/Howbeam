import { t } from '@/lib/shared/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  getProject: vi.fn(),
  discardPristineProject: vi.fn(),
  getActiveProjectId: vi.fn(),
  setActiveProjectId: vi.fn(),
  clearActiveProjectId: vi.fn(),
  getRecordingState: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('wxt/browser', () => ({ browser: { runtime: { sendMessage: mocks.sendMessage } } }));
vi.mock('@/lib/storage/project-repository', () => ({
  createProject: mocks.createProject,
  getProject: mocks.getProject,
  discardPristineProject: mocks.discardPristineProject,
}));
vi.mock('@/lib/storage/storage', () => ({
  getActiveProjectId: mocks.getActiveProjectId,
  setActiveProjectId: mocks.setActiveProjectId,
  clearActiveProjectId: mocks.clearActiveProjectId,
  getRecordingState: mocks.getRecordingState,
}));

import {
  clearSelectedProject,
  ensureSelectedProject,
  getSelectedProject,
  openSelectedProjectInEditor,
  selectProject,
  startRecording,
} from '@/lib/project/project-actions';

function project(id: string) {
  return {
    id,
    title: id,
    description: '',
    createdAt: 1,
    updatedAt: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setActiveProjectId.mockResolvedValue(undefined);
  mocks.clearActiveProjectId.mockResolvedValue(true);
  mocks.sendMessage.mockResolvedValue({ ok: true });
});

describe('Project UI selection', () => {
  it('selects through ACTIVE_PROJECT_ID without reading or replacing RecordingState', async () => {
    mocks.getProject.mockResolvedValue(project('project-a'));

    await expect(selectProject('project-a')).resolves.toMatchObject({ id: 'project-a' });

    expect(mocks.getProject).toHaveBeenCalledWith('project-a');
    expect(mocks.setActiveProjectId).toHaveBeenCalledWith('project-a');
  });

  it('preserves invocation order when an earlier Project lookup resolves slowly', async () => {
    const first = deferred<ReturnType<typeof project>>();
    mocks.getProject.mockImplementation((id: string) =>
      id === 'project-a' ? first.promise : Promise.resolve(project(id)),
    );

    const selectingA = selectProject('project-a');
    const selectingB = selectProject('project-b');
    await Promise.resolve();
    expect(mocks.getProject).toHaveBeenCalledTimes(1);

    first.resolve(project('project-a'));
    await Promise.all([selectingA, selectingB]);

    expect(mocks.setActiveProjectId.mock.calls).toEqual([['project-a'], ['project-b']]);
  });

  it('creates a fresh Project for a stale selection instead of resurrecting its deleted id', async () => {
    mocks.getActiveProjectId.mockResolvedValue('deleted-project');
    mocks.getProject.mockResolvedValue(undefined);
    mocks.createProject.mockResolvedValue(project('fresh-project'));

    await expect(ensureSelectedProject()).resolves.toMatchObject({ id: 'fresh-project' });

    expect(mocks.clearActiveProjectId).toHaveBeenCalledWith('deleted-project');
    expect(mocks.createProject).toHaveBeenCalledOnce();
    expect(mocks.setActiveProjectId).toHaveBeenCalledWith('fresh-project');
  });

  it('sends an explicit sessionId when opening the selected Project', async () => {
    mocks.getProject.mockResolvedValue(project('project-a'));

    await openSelectedProjectInEditor('project-a');

    expect(mocks.sendMessage).toHaveBeenCalledWith({
      type: 'OPEN_EDITOR',
      sessionId: 'project-a',
    });
  });

  it('reports a missing background response instead of dereferencing undefined', async () => {
    mocks.getProject.mockResolvedValue(project('project-a'));
    mocks.sendMessage.mockResolvedValue(undefined);

    await expect(openSelectedProjectInEditor('project-a')).rejects.toThrow('無法連接編輯器');
  });

  it('compare-and-clears selection without consulting capture operation state', async () => {
    await clearSelectedProject('project-a');

    expect(mocks.clearActiveProjectId).toHaveBeenCalledWith('project-a');
  });

  it('reads the selected Project without clearing a stale selection', async () => {
    mocks.getActiveProjectId.mockResolvedValue('deleted-project');
    mocks.getProject.mockResolvedValue(undefined);

    await expect(getSelectedProject()).resolves.toBeNull();

    expect(mocks.clearActiveProjectId).not.toHaveBeenCalled();
    expect(mocks.setActiveProjectId).not.toHaveBeenCalled();
  });
});

// The pristine guard itself lives in lib/storage (see tests/integration/db-pristine-project.test.ts); this suite covers only the UI-flow wrapper: delegation and restoring the prior selection.
describe('popup start (startRecording)', () => {
  it('asks the background to record into a Project of its own', async () => {
    mocks.sendMessage.mockResolvedValue({ ok: true, sessionId: 'project-new', runId: 'run-1' });
    await startRecording('snapshot');
    expect(mocks.sendMessage).toHaveBeenCalledWith({
      type: 'START_RECORDING',
      target: { kind: 'new' },
      mode: 'snapshot',
    });
    // The background owns the whole start: nothing is created or selected here.
    expect(mocks.setActiveProjectId).not.toHaveBeenCalled();
  });

  it('appends to an existing Project when one is picked', async () => {
    mocks.sendMessage.mockResolvedValue({ ok: true, sessionId: 'project-a', runId: 'run-1' });
    await startRecording('steps', 'project-a');
    expect(mocks.sendMessage).toHaveBeenCalledWith({
      type: 'START_RECORDING',
      target: { kind: 'project', projectId: 'project-a' },
      mode: 'steps',
    });
  });

  it("reports why the background refused, in the reader's language", async () => {
    mocks.sendMessage.mockResolvedValue({ ok: false, error: 'background.cannotStartHere' });
    await expect(startRecording('steps')).rejects.toThrow(t().background.cannotStartHere);
  });
});
