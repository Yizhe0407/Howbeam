import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { AlertCircle, Library, Settings } from 'lucide-react';
import { useRecordingSession } from '@/lib/recording/use-recording-session';
import { Alert, AlertDescription } from '@/components/ui/alert';
import OpenEditorButton from '@/components/popup/OpenEditorButton';
import RecordControls from '@/components/popup/RecordControls';
import ResetButton from '@/components/shared/ResetButton';
import { Button, buttonVariants } from '@/components/ui/button';
import BrandMark from '@/components/shared/BrandMark';
import { cn } from '@/lib/shared/utils';
import { needsEditorRecovery } from '@/lib/recording/recording-recovery';
import type { OpenEditorResult } from '@/lib/runtime/messages';
import { openLibrary, openSettings } from '@/lib/runtime/actions';
import { ensureSelectedProject } from '@/lib/project/project-actions';
import { getProject } from '@/lib/storage/project-repository';
import { subscribeProjectsChanged } from '@/lib/storage/change-notifier';
import { reportError } from '@/components/shared/report-error';
import { isOpenEditorResult, requireRuntimeMessageResult } from '@/lib/runtime/runtime-message-result';
import { t } from '@/lib/shared/i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

function App() {
  // Opts out of step reads: the full hook re-fetches every step (screenshot
  // Blobs included) on each state change, which a 320px popup never shows.
  const { recording, isRecording, sessionId, error, recoverableError, dataError } =
    useRecordingSession(undefined, { withSteps: false });
  const [openingEditor, setOpeningEditor] = useState(false);
  const [editorOpenError, setEditorOpenError] = useState<string | null>(null);
  // The 「錄到哪裡」 selection (null = 新專案). Reset acts on exactly this project,
  // never on the last recording's, so what the user picked is what gets cleared.
  const [targetProjectId, setTargetProjectId] = useState<string | null>(null);
  // The reset target's title and whether it holds any content. `recording.itemCount`
  // cannot answer this since it's per-run and zeroed on finish; the counts live on the project row.
  const [resetTarget, setResetTarget] = useState<{ title: string; hasContent: boolean } | null>(null);
  const editorRecovery = needsEditorRecovery(recoverableError);

  useEffect(() => {
    if (!targetProjectId) {
      setResetTarget(null);
      return;
    }
    let active = true;
    const refresh = () => {
      void getProject(targetProjectId)
        .then((project) => {
          if (!active) return;
          setResetTarget(project
            ? {
                title: project.title.trim() || t().common.untitledProject,
                hasContent: project.entryCount > 0 || project.stepCount > 0,
              }
            : null);
        })
        .catch((readError) => {
          // Fail open: the confirm dialog and background guard still protect the
          // action, while failing closed would strand a real reset need.
          console.error('[howbeam] failed to read project summary', readError);
          if (active) setResetTarget({ title: t().common.untitledProject, hasContent: true });
        });
    };
    refresh();
    // phase re-runs the read after a run finishes and bumps the counts; project
    // changes cover resets, deletions and edits made from other pages.
    const unsubscribe = subscribeProjectsChanged(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [targetProjectId, recording.phase]);

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

      {/* Hidden while a run is live: RecordControls already offers the editor as
          its secondary exit, and a mid-recording reset would fail anyway. */}
      {!editorRecovery && !isRecording && <div className="h-0.5 w-full rounded-full bg-border-soft" aria-hidden="true" />}

      {!editorRecovery && !isRecording && (
        <div className="flex flex-col gap-2">
          <OpenEditorButton
            label={t().common.openEditor}
            pending={openingEditor}
            onOpen={openEditor}
            className={cn(buttonVariants({ variant: 'outline' }), 'w-full')}
          />
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" size="sm" onClick={() => void openLibraryView()} className="w-full">
              <Library />{t().common.library}
            </Button>
            <ResetButton
              hasSteps={resetTarget?.hasContent ?? false}
              sessionId={resetTarget ? targetProjectId : null}
              projectTitle={resetTarget?.title}
              onReset={() => setResetTarget((current) => (current ? { ...current, hasContent: false } : current))}
              variant="outline" className="h-8 w-full px-3 text-[13px]"
            />
          </div>
        </div>
      )}

    </main>
  );
}

export default App;
