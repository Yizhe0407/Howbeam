import { useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { browser } from 'wxt/browser';
import { Button } from '@/components/ui/button';
import InlineAlert from '@/components/shared/InlineAlert';
import Mascot from '@/components/shared/Mascot';
import { reportError } from '@/components/shared/report-error';
import { byMostRecentlyAccessed } from '@/lib/editor/continuation-tabs';
import { focusTab } from '@/lib/runtime/navigation';
import { isRecordableTab } from '@/lib/shared/restricted-urls';
import { t } from '@/lib/shared/i18n';
import { useDeferredBusy } from '@/lib/shared/use-deferred-busy';

interface Props {
  isRecording?: boolean;
  recordingTabId?: number | null;
}

export default function EmptyState({ isRecording = false, recordingTabId = null }: Props) {
  const [pending, setPending] = useState(false);
  const pendingShown = useDeferredBusy(pending);
  const [actionError, setActionError] = useState<string | null>(null);

  async function returnToRecordingPage() {
    if (pending) return;
    setPending(true);
    setActionError(null);
    try {
      const tabs = await browser.tabs.query({ currentWindow: true });
      // Prefer the recording tab; otherwise the most recently used recordable
      // tab (http/https only — file: pages can't be recorded).
      const target =
        tabs.find((tab) => tab.id === recordingTabId) ??
        tabs.filter(isRecordableTab).sort(byMostRecentlyAccessed)[0];
      if (target?.id == null) throw new Error(t().emptyState.noRecordableTab);

      await focusTab(target.id, target.windowId);

      if (!isRecording) {
        const browserApis = browser as typeof browser & {
          browserAction?: { openPopup?: () => Promise<void> };
        };
        const actionApi = browserApis.action ?? browserApis.browserAction;
        await actionApi?.openPopup?.();
      }
    } catch (error) {
      setActionError(reportError('[howbeam] failed to return to the recording page', error, t().emptyState.returnFailed));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <Mascot className="size-16" />
      <div className="flex max-w-[380px] flex-col items-center gap-2">
        <h2 className="text-lg font-bold text-foreground">{t().emptyState.title}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t().emptyState.body}
        </p>
        <Button onClick={returnToRecordingPage} disabled={pendingShown} className="mt-2">
          {pendingShown ? <Loader2 className="animate-spin" /> : <ExternalLink />}
          {pendingShown ? t().emptyState.opening : isRecording ? t().emptyState.returnToRecordingTab : t().emptyState.returnToPage}
        </Button>
        {actionError && <InlineAlert className="text-left">{actionError}</InlineAlert>}
      </div>
    </main>
  );
}
