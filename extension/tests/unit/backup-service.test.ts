import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runBackup: vi.fn(),
  getBackupConfig: vi.fn(),
  saveBackupLastRun: vi.fn(),
}));

vi.mock('@/lib/backup/backup-runner', () => ({ runBackup: mocks.runBackup }));
vi.mock('@/lib/backup/directory-handle', () => ({ queryBackupPermission: async () => 'granted' }));
vi.mock('@/lib/backup/backup-store', () => ({
  getBackupConfig: mocks.getBackupConfig,
  getBackupManifest: vi.fn(),
  putBackupManifestEntry: vi.fn(),
  saveBackupLastRun: mocks.saveBackupLastRun,
}));
vi.mock('@/lib/storage/project-repository', () => ({ getProjectSummaries: vi.fn() }));
vi.mock('@/lib/storage/step-repository', () => ({ getSteps: vi.fn() }));
vi.mock('@/lib/export/project-archive-serialize', () => ({ exportProjectArchive: vi.fn() }));

/** Just enough of navigator.locks: one holder at a time, FIFO waiters, ifAvailable. */
function installFakeLocks() {
  let held = false;
  const waiters: Array<() => void> = [];
  const release = () => {
    const next = waiters.shift();
    if (next) next();
    else held = false;
  };
  const request = async (_name: string, a: unknown, b?: unknown) => {
    const options = (typeof a === 'function' ? {} : a) as { ifAvailable?: boolean };
    const callback = (typeof a === 'function' ? a : b) as (lock: object | null) => unknown;
    if (held) {
      if (options.ifAvailable) return callback(null);
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    held = true;
    try {
      return await callback({});
    } finally {
      release();
    }
  };
  Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
}

describe('runFolderBackup', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.runBackup.mockReset();
    mocks.getBackupConfig.mockResolvedValue({ directory: {}, folderName: 'x' });
    installFakeLocks();
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'locks');
  });

  it('runs again after the lock is released when a change arrives mid-run', async () => {
    let releaseFirst!: () => void;
    mocks.runBackup
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () => resolve({ written: 1, skipped: 0, failed: 0, error: null, failedTitles: [] });
          }),
      )
      .mockResolvedValue({ written: 1, skipped: 0, failed: 0, error: null, failedTitles: [] });
    const { runFolderBackup } = await import('@/lib/backup/backup-service');

    const first = runFolderBackup();
    await vi.waitFor(() => expect(mocks.runBackup).toHaveBeenCalledTimes(1));
    // Several changes while the first run holds the lock coalesce into one follow-up run.
    const second = runFolderBackup();
    const third = runFolderBackup();
    await Promise.resolve();
    expect(mocks.runBackup).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([first, second, third]);
    expect(mocks.runBackup).toHaveBeenCalledTimes(2);
  });
});
