import { useState } from 'react';
import { FolderOpen, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import ConfirmationDialog from '@/components/shared/ConfirmationDialog';
import { Button } from '@/components/ui/button';
import { useFolderBackup } from '@/lib/backup/use-folder-backup';
import { intlLocale, t } from '@/lib/shared/i18n';

const MAX_NAMED_FAILURES = 3;

/** The failed projects' titles, capped so one broken folder cannot fill the card. */
function failedNames(run: { failedTitles?: string[] }): string {
  const titles = run.failedTitles ?? [];
  const shown = titles.slice(0, MAX_NAMED_FAILURES).map((title) => `“${title}”`).join(', ');
  return titles.length > MAX_NAMED_FAILURES ? `${shown}…` : shown;
}

/** Settings card for automatic folder backup: choose a folder once, then every
 * change is saved there as a .howbeam file. */
export default function BackupSettingsSection() {
  const backup = useFolderBackup();
  const [confirmOff, setConfirmOff] = useState(false);
  const copy = t().settings.backup;
  const { folderName, availability, lastRun } = backup;
  const enabled = folderName !== null;

  const lastRunTime = lastRun ? new Date(lastRun.at).toLocaleString(intlLocale()) : '';
  const lastRunLabel = !lastRun
    ? copy.notYetRun
    : lastRun.written === 0 && lastRun.failed === 0
      ? copy.upToDate(lastRunTime)
      : copy.lastRun(lastRunTime, lastRun.written);

  return (
    <section aria-labelledby="settings-backup" className="flex flex-col gap-4 rounded-md border-2 border-border bg-card p-5">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id="settings-backup" className="text-base font-bold">{copy.title}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{copy.description}</p>
      </div>

      {!backup.supported ? (
        <p className="text-sm text-muted-foreground">{copy.unsupported}</p>
      ) : backup.loading ? null : !enabled ? (
        <div className="flex flex-col gap-2">
          <div>
            <Button variant="outline" onClick={() => void backup.choose()} disabled={backup.busy}>
              {backup.busy ? <Loader2 className="animate-spin" /> : <FolderOpen />}{copy.choose}
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">{copy.folderHint}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex min-w-0 flex-col gap-0.5 text-sm">
            <span className="flex items-center gap-1.5 font-bold">
              <FolderOpen className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">{copy.folder(folderName)}</span>
            </span>
            <span className="text-muted-foreground">
              {availability === 'needs-permission' ? copy.needsPermission : lastRunLabel}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {availability === 'needs-permission' ? (
              <Button onClick={() => void backup.reauthorize()} disabled={backup.busy}>
                {backup.busy ? <Loader2 className="animate-spin" /> : <ShieldAlert />}{copy.reauthorize}
              </Button>
            ) : (
              <Button variant="outline" onClick={() => void backup.backUpNow()} disabled={backup.busy}>
                {backup.busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}{copy.backUpNow}
              </Button>
            )}
            <Button variant="outline" onClick={() => void backup.choose()} disabled={backup.busy}>{copy.change}</Button>
            <Button variant="outline" onClick={() => setConfirmOff(true)} disabled={backup.busy}>{copy.turnOff}</Button>
          </div>
        </div>
      )}

      {backup.error && <p role="alert" className="text-sm text-danger">{copy.failed}</p>}
      {backup.lastRun && backup.lastRun.failed > 0 && !backup.error && (
        <p role="alert" className="text-sm text-danger">{copy.someFailed(backup.lastRun.failed, failedNames(backup.lastRun))}</p>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">{copy.privacy}</p>
      <ConfirmationDialog
        open={confirmOff}
        title={copy.turnOffTitle}
        description={copy.turnOffBody(folderName ?? '')}
        confirmLabel={copy.turnOff}
        confirmVariant="default"
        pending={backup.busy}
        onOpenChange={setConfirmOff}
        onConfirm={async () => {
          await backup.turnOff();
          setConfirmOff(false);
        }}
      />
    </section>
  );
}
