import { describe, expect, it, vi } from 'vitest';
import { backupFilename, fallbackBackupFilename, runBackup, type BackupRunDeps } from '@/lib/backup/backup-runner';
import type { BackupManifestEntry } from '@/lib/backup/backup-store';
import type { ProjectSummary } from '@/lib/storage/models';

/** Minimal in-memory stand-in for a FileSystemDirectoryHandle. */
function fakeDirectory(failOn?: string, asciiOnly = false) {
  const files = new Map<string, Blob>();
  const directory = {
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (asciiOnly && /[^\x20-\x7e]/.test(name)) throw new DOMException('bad name', 'TypeMismatchError');
      if (!files.has(name) && !options?.create) throw new DOMException('missing', 'NotFoundError');
      return {
        async createWritable() {
          return {
            async write(blob: Blob) {
              if (failOn && name.includes(failOn)) throw new Error('disk full');
              files.set(name, blob);
            },
            async close() {},
            async abort() {},
          };
        },
      };
    },
    async removeEntry(name: string) {
      files.delete(name);
    },
  } as unknown as FileSystemDirectoryHandle;
  return { directory, files };
}

/** updatedAt is deliberately constant: the backup must follow the revisions, not the clock. */
function project(id: string, title: string, contentRevision: number, metadataRevision = 0): ProjectSummary {
  return { id, title, description: '', sections: [], tags: [], createdAt: 0, updatedAt: 0, contentRevision, metadataRevision, stepCount: 0, entryCount: 0, storageBytes: 0 };
}

function setup(projects: ProjectSummary[], failOn?: string, asciiOnly = false) {
  const { directory, files } = fakeDirectory(failOn, asciiOnly);
  const manifest = new Map<string, BackupManifestEntry>();
  const deps: BackupRunDeps = {
    directory,
    listProjects: async () => projects,
    buildArchive: vi.fn(async (p: ProjectSummary) => new Blob([`archive:${p.id}:${p.contentRevision}`])),
    getManifest: async () => new Map(manifest),
    putManifestEntry: async (id, entry) => void manifest.set(id, entry),
    now: () => 1_000,
  };
  return { deps, files, manifest };
}

describe('backupFilename', () => {
  it('is stable per project and distinguishes projects that share a title', () => {
    const a = backupFilename({ id: 'aaaaaaaa-1111', title: '登入流程' });
    const b = backupFilename({ id: 'bbbbbbbb-2222', title: '登入流程' });
    expect(a).not.toBe(b);
    expect(a).toBe(backupFilename({ id: 'aaaaaaaa-1111', title: '登入流程' }));
    expect(a.endsWith('.stepmark')).toBe(true);
    expect(backupFilename({ id: 'aaaaaaaa-1111', title: 'a/b:c*?' })).not.toMatch(/[\\/:*?"<>|]/);
  });
});

describe('backupFilename length', () => {
  it('stays within 255 UTF-8 bytes for long CJK and emoji titles', () => {
    for (const title of ['中'.repeat(120), '😀'.repeat(120), 'a'.repeat(300)]) {
      const name = backupFilename({ id: 'aaaaaaaa-1111', title });
      expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
      expect(name.endsWith('-aaaaaaaa.stepmark')).toBe(true);
      expect(name).not.toContain('\uFFFD');
    }
  });
});

describe('runBackup', () => {
  it('rewrites an edit even when updatedAt did not move (clock went backwards)', async () => {
    const projects = [project('aaaaaaaa-1', 'One', 4)];
    const { deps } = setup(projects);
    await runBackup(deps);
    projects[0] = project('aaaaaaaa-1', 'One', 5);
    expect(await runBackup(deps)).toMatchObject({ written: 1, skipped: 0 });
  });

  it('rewrites a project whose only change is its metadata', async () => {
    const projects = [project('aaaaaaaa-1', 'One', 4, 0)];
    const { deps } = setup(projects);
    await runBackup(deps);
    projects[0] = project('aaaaaaaa-1', 'One', 4, 1);
    expect(await runBackup(deps)).toMatchObject({ written: 1, skipped: 0 });
  });

  it('rewrites a project whose manifest entry predates the metadata revision', async () => {
    const { deps, manifest } = setup([project('aaaaaaaa-1', 'One', 3)]);
    await runBackup(deps);
    const entry = manifest.get('aaaaaaaa-1')!;
    manifest.set('aaaaaaaa-1', { contentRevision: 3, filename: entry.filename, backedUpAt: 1 } as unknown as BackupManifestEntry);
    expect(await runBackup(deps)).toMatchObject({ written: 1, skipped: 0 });
  });

  it('rewrites a project whose manifest entry predates revisions', async () => {
    const { deps, manifest } = setup([project('aaaaaaaa-1', 'One', 0)]);
    await runBackup(deps);
    const entry = manifest.get('aaaaaaaa-1')!;
    manifest.set('aaaaaaaa-1', { updatedAt: 0, filename: entry.filename, backedUpAt: 1 } as unknown as BackupManifestEntry);
    expect(await runBackup(deps)).toMatchObject({ written: 1, skipped: 0 });
    expect(manifest.get('aaaaaaaa-1')).toMatchObject({ contentRevision: 0 });
  });

  it('names the projects that failed', async () => {
    const { deps } = setup([project('aaaaaaaa-1', 'Broken', 1), project('bbbbbbbb-2', 'Fine', 1)], 'aaaaaaaa');
    expect(await runBackup(deps)).toMatchObject({ failed: 1, failedTitles: ['Broken'] });
  });

  it('writes new projects, then skips them until they change', async () => {
    const projects = [project('aaaaaaaa-1', 'One', 10), project('bbbbbbbb-2', 'Two', 20)];
    const { deps, files } = setup(projects);

    expect(await runBackup(deps)).toMatchObject({ written: 2, skipped: 0, failed: 0 });
    expect(files.size).toBe(2);

    expect(await runBackup(deps)).toMatchObject({ written: 0, skipped: 2, failed: 0 });

    projects[0] = project('aaaaaaaa-1', 'One', 11);
    expect(await runBackup(deps)).toMatchObject({ written: 1, skipped: 1, failed: 0 });
    expect(deps.buildArchive).toHaveBeenCalledTimes(3);
  });

  it('rewrites a file the user deleted by hand', async () => {
    const { deps, files } = setup([project('aaaaaaaa-1', 'One', 10)]);
    await runBackup(deps);
    files.clear();
    expect(await runBackup(deps)).toMatchObject({ written: 1, skipped: 0 });
    expect(files.size).toBe(1);
  });

  it('renames the file when the project is renamed, without leaving the old one behind', async () => {
    const projects = [project('aaaaaaaa-1', 'Old name', 10)];
    const { deps, files } = setup(projects);
    await runBackup(deps);
    const [oldName] = [...files.keys()];

    projects[0] = project('aaaaaaaa-1', 'New name', 10, 1);
    await runBackup(deps);

    expect(files.has(oldName)).toBe(false);
    expect([...files.keys()]).toEqual([backupFilename(projects[0])]);
  });

  it('keeps the backup of a project that was deleted from Stepmark', async () => {
    const projects = [project('aaaaaaaa-1', 'One', 10), project('bbbbbbbb-2', 'Two', 20)];
    const { deps, files } = setup(projects);
    await runBackup(deps);

    projects.pop();
    await runBackup(deps);

    expect(files.size).toBe(2);
  });

  it('does not let one failing project block the others, and retries it next time', async () => {
    const projects = [project('aaaaaaaa-1', 'Broken', 10), project('bbbbbbbb-2', 'Fine', 20)];
    const failing = setup(projects, 'aaaaaaaa');
    const result = await runBackup(failing.deps);

    expect(result).toMatchObject({ written: 1, failed: 1, error: 'disk full' });
    expect(failing.manifest.has('aaaaaaaa-1')).toBe(false);
    expect(failing.manifest.has('bbbbbbbb-2')).toBe(true);

    // Same manifest, healthy disk: the failed project is picked up again.
    const healthy = fakeDirectory();
    const retry = await runBackup({ ...failing.deps, directory: healthy.directory });
    expect(retry.written).toBe(2);
  });

  it('falls back to a plain ASCII name when the folder rejects the readable one, and stays stable', async () => {
    const projects = [project('aaaaaaaa-1', '登入流程教學', 10)];
    const { deps, files } = setup(projects, undefined, true);

    expect(await runBackup(deps)).toMatchObject({ written: 1, failed: 0 });
    expect([...files.keys()]).toEqual([fallbackBackupFilename(projects[0])]);

    expect(await runBackup(deps)).toMatchObject({ written: 0, skipped: 1, failed: 0 });
  });
});
