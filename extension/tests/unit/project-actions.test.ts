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
  discardUntouchedProject,
  ensureSelectedProject,
  getSelectedProject,
  openSelectedProjectInEditor,
  selectProject,
  startRecordingIntoProject,
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
  const promise = new Promise<T>((done) => { resolve = done; });
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
describe('auto-created Project reclamation', () => {
  it('delegates deletion to storage and restores the previous selection', async () => {
    mocks.discardPristineProject.mockResolvedValue(true);
    mocks.getProject.mockImplementation(async (id: string) => project(id));

    await expect(discardUntouchedProject('project-fresh', 'project-old')).resolves.toBe(true);

    expect(mocks.discardPristineProject).toHaveBeenCalledExactlyOnceWith('project-fresh');
    expect(mocks.setActiveProjectId).toHaveBeenCalledWith('project-old');
  });

  it('does not restore anything when storage declined to delete', async () => {
    mocks.discardPristineProject.mockResolvedValue(false);

    await expect(discardUntouchedProject('project-touched', 'project-old')).resolves.toBe(false);

    expect(mocks.setActiveProjectId).not.toHaveBeenCalled();
  });

  it('skips restoring a previous selection that no longer exists', async () => {
    mocks.discardPristineProject.mockResolvedValue(true);
    mocks.getProject.mockResolvedValue(undefined);

    await expect(discardUntouchedProject('project-fresh', 'project-gone')).resolves.toBe(true);

    expect(mocks.setActiveProjectId).not.toHaveBeenCalled();
  });

  it('never re-selects the project it just discarded', async () => {
    mocks.discardPristineProject.mockResolvedValue(true);
    mocks.getProject.mockImplementation(async (id: string) => project(id));

    await expect(discardUntouchedProject('project-fresh', 'project-fresh')).resolves.toBe(true);

    expect(mocks.setActiveProjectId).not.toHaveBeenCalled();
  });
});

describe('popup start transaction (startRecordingIntoProject)', () => {
  beforeEach(() => {
    mocks.getActiveProjectId.mockResolvedValue('project-old');
    mocks.getProject.mockImplementation(async (id: string) => project(id));
    mocks.createProject.mockResolvedValue(project('project-new'));
    mocks.getRecordingState.mockResolvedValue({ isRecording: false, sessionId: null });
  });

  it('creates, selects, and starts recording into a fresh project', async () => {
    mocks.sendMessage.mockResolvedValue({ ok: true, sessionId: 'project-new', runId: 'run-1' });

    await expect(startRecordingIntoProject('steps')).resolves.toMatchObject({ id: 'project-new' });

    expect(mocks.sendMessage).toHaveBeenCalledWith({
      type: 'START_RECORDING',
      sessionId: 'project-new',
      mode: 'steps',
      autoCreatedProject: true,
    });
    expect(mocks.discardPristineProject).not.toHaveBeenCalled();
  });

  it('rolls back the fresh project and restores the previous selection on failure', async () => {
    mocks.sendMessage.mockResolvedValue({ ok: false, error: 'background.cannotStartHere' });
    mocks.discardPristineProject.mockResolvedValue(true);

    await expect(startRecordingIntoProject('steps')).rejects.toThrow(t().background.cannotStartHere);

    expect(mocks.discardPristineProject).toHaveBeenCalledExactlyOnceWith('project-new');
    expect(mocks.setActiveProjectId).toHaveBeenLastCalledWith('project-old');
  });

  it('keeps the fresh project when the run actually started but the response was lost', async () => {
    mocks.sendMessage.mockResolvedValue(undefined);
    mocks.getRecordingState.mockResolvedValue({ isRecording: true, sessionId: 'project-new' });

    await expect(startRecordingIntoProject('steps')).rejects.toThrow('無法連接錄製功能');

    expect(mocks.discardPristineProject).not.toHaveBeenCalled();
  });
});

describe('popup start transaction into an existing project', () => {
  beforeEach(() => {
    mocks.getActiveProjectId.mockResolvedValue('project-old');
    mocks.getProject.mockImplementation(async (id: string) => project(id));
    mocks.getRecordingState.mockResolvedValue({ isRecording: false, sessionId: null });
  });

  it('selects the target and starts without creating a project or marking it reclaimable', async () => {
    mocks.sendMessage.mockResolvedValue({ ok: true, sessionId: 'project-target', runId: 'run-1' });

    await expect(startRecordingIntoProject('steps', 'project-target')).resolves.toMatchObject({ id: 'project-target' });

    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(mocks.setActiveProjectId).toHaveBeenCalledWith('project-target');
    // No autoCreatedProject: the background must never reclaim an existing project.
    expect(mocks.sendMessage).toHaveBeenCalledExactlyOnceWith({
      type: 'START_RECORDING',
      sessionId: 'project-target',
      mode: 'steps',
    });
  });

  it('restores the previous selection and never deletes the project when start fails', async () => {
    mocks.sendMessage.mockResolvedValue({ ok: false, error: 'background.cannotStartHere' });

    await expect(startRecordingIntoProject('steps', 'project-target')).rejects.toThrow(t().background.cannotStartHere);

    expect(mocks.discardPristineProject).not.toHaveBeenCalled();
    expect(mocks.setActiveProjectId).toHaveBeenLastCalledWith('project-old');
  });

  it('keeps the selection when the run actually started but the response was lost', async () => {
    mocks.sendMessage.mockResolvedValue(undefined);
    mocks.getRecordingState.mockResolvedValue({ isRecording: true, sessionId: 'project-target' });

    await expect(startRecordingIntoProject('steps', 'project-target')).rejects.toThrow('無法連接錄製功能');

    expect(mocks.setActiveProjectId).toHaveBeenCalledExactlyOnceWith('project-target');
  });

  it('fails without starting when the target project no longer exists', async () => {
    mocks.getProject.mockImplementation(async (id: string) => (id === 'project-old' ? project(id) : undefined));

    await expect(startRecordingIntoProject('steps', 'project-gone')).rejects.toThrow('找不到這個專案');

    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
});
