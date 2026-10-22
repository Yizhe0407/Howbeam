import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useFolderBackup } from '@/lib/backup/use-folder-backup';
import { t } from '@/lib/shared/i18n';

/** Shown only when backup is on but the browser asked for access again (it
 * forgets folder permission across restarts). One click resumes it. */
export default function BackupPausedNotice() {
  const backup = useFolderBackup();
  if (backup.loading || backup.folderName === null || backup.availability !== 'needs-permission') return null;
  return (
    <Alert className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <AlertDescription>{t().settings.backup.paused}</AlertDescription>
      <Button size="sm" onClick={() => void backup.reauthorize()} disabled={backup.busyShown}>
        {t().settings.backup.reauthorize}
      </Button>
    </Alert>
  );
}
