import { useState } from 'react';
import { browser } from 'wxt/browser';
import { AlertCircle, Library, Settings } from 'lucide-react';
import { useRecordingSession } from '@/lib/recording/use-recording-session';
import { Alert, AlertDescription } from '@/components/ui/alert';
import RecordControls from '@/components/popup/RecordControls';
import { Button } from '@/components/ui/button';
import BrandMark from '@/components/shared/BrandMark';
import { needsEditorRecovery } from '@/lib/recording/recording-recovery';
import type { OpenEditorResult } from '@/lib/runtime/messages';
import { openLibrary, openSettings } from '@/lib/runtime/actions';
import { ensureSelectedProject } from '@/lib/project/project-actions';
import { reportError } from '@/components/shared/report-error';
import { isOpenEditorResult, requireRuntimeMessageResult } from '@/lib/runtime/runtime-message-result';
import { t } from '@/lib/shared/i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

function App() {
  const { recording, isRecording, sessionId, error, recoverableError, dataError } = useRecordingSession();
  const [openingEditor, setOpeningEditor] = useState(false);
  const [editorOpenError, setEditorOpenError] = useState<string | null>(null);
  // The 「錄到哪裡」 selection (null = 新專案).
  const [targetProjectId, setTargetProjectId] = useState<string | null>(null);
  const editorRecovery = needsEditorRecovery(recoverableError);

  async function openSettingsPage() {
    setEditorOpenError(null);
    try {
      await openSettings();
      window.close();
    } catch (settingsError) {
      console.error('[howbeam] failed to open settings', settingsError);
      setEditorOpenError(t().nav.settingsOpenFailed);
    }
  }

  async function openLibraryView() {
    setEditorOpenError(null);
    try {
      await openLibrary();
      window.close();
    } catch (navigationError) {
      console.error('[howbeam] failed to open library', navigationError);
      setEditorOpenError(t().nav.libraryOpenFailed);
    }
  }

  async function openEditor() {
    if (openingEditor) return;
    setOpeningEditor(true);
    setEditorOpenError(null);
    try {
      // Recovery must return to the operation owner; normal navigation resolves the
      // current UI selection afresh so an idle popup never opens a project-less editor.
      const targetSessionId = editorRecovery
        ? sessionId
        : (await ensureSelectedProject()).id;
      const result = requireRuntimeMessageResult<OpenEditorResult>(
        await browser.runtime.sendMessage({
          type: 'OPEN_EDITOR',
          sessionId: targetSessionId ?? undefined,
        }),
        isOpenEditorResult,
        t().popup.editorServiceUnavailable,
      );
      if (!result.ok) {
        setEditorOpenError(result.error);
        return;
      }
      window.close();
    } catch (openError) {
      setEditorOpenError(
        reportError('[howbeam] failed to request editor navigation', openError, t().runtime.editorOpenFailed),
      );
    } finally {
      setOpeningEditor(false);
    }
  }

  function handleStarted() {
    window.close();
  }

  return (
    <main className="flex w-[320px] flex-col gap-4 bg-card p-5">
      <div className="flex items-center justify-between gap-3">
        <BrandMark heading />
        <div className="flex shrink-0 items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={t().settings.open}
                onClick={() => void openSettingsPage()}
              >
                <Settings />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t().settings.open}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {(editorOpenError || recoverableError?.message || error || dataError) && !isRecording && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{editorOpenError ?? recoverableError?.message ?? error ?? dataError}</AlertDescription>
        </Alert>
      )}

      <RecordControls
        recording={recording}
        onStarted={handleStarted}
        onOpenEditor={openEditor}
        openingEditor={openingEditor}
        targetProjectId={targetProjectId}
        onTargetProjectChange={setTargetProjectId}
      />

      {!editorRecovery && !isRecording && <div className="h-0.5 w-full rounded-full bg-border-soft" aria-hidden="true" />}

      {!editorRecovery && !isRecording && (
        <Button variant="outline" onClick={() => void openLibraryView()} className="w-full">
          <Library />{t().common.library}
        </Button>
      )}

    </main>
  );
}

export default App;
