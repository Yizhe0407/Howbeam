// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackupLastRun } from '@/lib/backup/backup-store';
import type { FolderBackupState } from '@/lib/backup/use-folder-backup';

const mocks = vi.hoisted(() => ({ lastRun: null as BackupLastRun | null }));

vi.mock('@/lib/backup/use-folder-backup', () => ({
  useFolderBackup: (): FolderBackupState => ({
    supported: true,
    loading: false,
    folderName: 'Stepmark Backup',
    availability: 'ready',
    lastRun: mocks.lastRun,
    busy: false,
    error: false,
    choose: vi.fn(),
    reauthorize: vi.fn(),
    backUpNow: vi.fn(),
    turnOff: vi.fn(),
  }),
}));

import BackupSettingsSection from '@/components/shared/BackupSettingsSection';

afterEach(cleanup);

const at = new Date(2026, 9, 18, 20, 40).getTime();

describe('BackupSettingsSection last run', () => {
  it('says not backed up yet before any run', () => {
    mocks.lastRun = null;
    render(<BackupSettingsSection />);
    expect(screen.getByText('尚未備份')).toBeTruthy();
  });

  it('counts the projects a run wrote', () => {
    mocks.lastRun = { at, written: 2, failed: 0, error: null };
    render(<BackupSettingsSection />);
    expect(screen.getByText(/^上次備份：.*（更新 2 個專案）$/)).toBeTruthy();
  });

  it('says everything is up to date when a run had nothing to write', () => {
    mocks.lastRun = { at, written: 0, failed: 0, error: null };
    render(<BackupSettingsSection />);
    expect(screen.getByText(/^上次檢查：.*（全部已是最新）$/)).toBeTruthy();
    expect(screen.queryByText(/更新 0 個專案/)).toBeNull();
  });

  it('keeps the written count when a run only had failures', () => {
    mocks.lastRun = { at, written: 0, failed: 1, error: 'denied', failedTitles: ['A'] };
    render(<BackupSettingsSection />);
    expect(screen.getByText(/^上次備份：.*（更新 0 個專案）$/)).toBeTruthy();
  });
});
