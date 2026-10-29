import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { AlertCircle, Library } from 'lucide-react';
import { useRecordingSession } from '@/lib/recording/use-recording-session';
import { useEditorProjectData } from '@/lib/editor/use-editor-project-data';
import { EditingBlockedError, EMPTY_SECTIONS, EMPTY_STEP_ENTRIES, type OptimisticChange } from '@/lib/editor/editor-app-model';
import { useSerialOperations } from '@/lib/editor/use-serial-operations';
import { entryId, projectDisplayTitle, type StepEntry } from '@/lib/storage/models';
import { sectionOfEntry } from '@/lib/project/project-sections';
import { updateProject, type ProjectMetadataChanges } from '@/lib/storage/project-repository';
import { ProjectNotFoundError } from '@/lib/storage/database';
import { DraftConfirmationRequiredError, EditorSaveProvider, useEditorSaveRegistry } from '@/lib/editor/editor-autosave';
import { Alert, AlertDescription } from '@/components/ui/alert';
import EditorHeader from '@/components/editor/EditorHeader';
import StepRail from '@/components/editor/StepRail';
import StepStage from '@/components/editor/StepStage';
import { useAutoFolderBackup } from '@/lib/backup/use-folder-backup';
import AppToaster from '@/components/shared/AppToaster';
import EmptyState from '@/components/shared/EmptyState';
import Mascot from '@/components/shared/Mascot';
import { Button } from '@/components/ui/button';
import Lightbox from '@/components/editor/Lightbox';
import RecaptureProgressDialog from '@/components/editor/RecaptureProgressDialog';
import SourcePermissionDialog from '@/components/editor/SourcePermissionDialog';
import { useBusyNotice, useUndoNotice } from '@/components/editor/use-notices';
import { useDeferredBusy } from '@/lib/shared/use-deferred-busy';
import SectionTitleDialog, { type SectionDialogRequest } from '@/components/editor/SectionTitleDialog';
import { usePermissionFlow } from '@/components/editor/use-permission-flow';
import { useProjectUndo } from '@/components/editor/use-project-undo';
import { useProjectMutations } from '@/components/editor/use-project-mutations';
import { exportImagesAsZip } from '@/lib/export/export-images';
import { throwIfAborted } from '@/lib/shared/abort';
import { browser } from 'wxt/browser';
import { focusTab, getEditorSessionIdFromUrl } from '@/lib/runtime/navigation';
import { useEditorEntryWorkspace } from '@/lib/editor/use-editor-entry-workspace';
import { useEditorHandoff } from '@/lib/editor/use-editor-handoff';
import { useExtensionPageRegistration } from '@/lib/runtime/use-extension-page-registration';
import { t } from '@/lib/shared/i18n';
import {
  ackStepRecaptureResult,
  cancelStepRecapture,
  focusStepRecaptureSource,
  openLibrary,
} from '@/lib/runtime/actions';
import type {
  CancelStepRecaptureResult,
  FocusStepRecaptureSourceResult,
} from '@/lib/runtime/messages';
import { reportError } from '@/components/shared/report-error';

async function showRecordedTab(tabId: number): Promise<void> {
  try {
    const tab = await browser.tabs.get(tabId);
    await focusTab(tabId, tab.windowId);
  } catch (error) {
    console.error('[howbeam] failed to show the recording tab', error);
  }
}

function EditorApp() {
  const viewedSessionId = useMemo(() => getEditorSessionIdFromUrl(window.location.href), []);
  const { sessionId, tabId, error, dataError, recording } = useRecordingSession(viewedSessionId);
  const {
    project,
    canonicalSnapshot,
    projectLoadState,
    projectDeleted,
    reload,
    requestReload,
    adoptCommitted,
    adoptProject,
  } = useEditorProjectData(sessionId);
  const operationBelongsToViewedProject = Boolean(sessionId && recording.sessionId === sessionId);
  const operationActive = operationBelongsToViewedProject && recording.operation !== null;
  const ordinaryRecordingActive = operationBelongsToViewedProject && recording.operation === 'recording';
  const recaptureActive = operationBelongsToViewedProject && recording.operation === 'recapture' && recording.recapture !== null;
  const { flushAll } = useEditorSaveRegistry();
  const dbEntries = canonicalSnapshot?.entries ?? EMPTY_STEP_ENTRIES;
  const dbSections = project?.sections ?? EMPTY_SECTIONS;
  const operations = useSerialOperations();
  const [exporting, setExporting] = useState(false);

  // What queued edits will do, each shown from its click over the stored entries until it settles.
  const [optimisticChanges, setOptimisticChanges] = useState<readonly { id: number; apply: OptimisticChange }[]>([]);
  const optimisticIds = useRef(0);
  const showOptimistic = useCallback((apply: OptimisticChange) => {
    const id = ++optimisticIds.current;
    setOptimisticChanges((current) => [...current, { id, apply }]);
    return () => setOptimisticChanges((current) => current.filter((change) => change.id !== id));
  }, []);
  const { entries, sections } = useMemo(
    () => optimisticChanges.reduce((shown, change) => change.apply(shown), { entries: dbEntries, sections: dbSections }),
    [dbEntries, dbSections, optimisticChanges],
  );
  const [operationError, setOperationError] = useState<string | null>(null);
  const handledRecaptureResult = useRef<string | null>(null);

  const {
    preparedPermission,
    permissionPending,
    permissionFlowActive,
    continueElsewherePending,
    continueElsewhereError,
    continuationTabs,
    selectedContinuationTabId,
    selectContinuationTab,
    isPermissionFlowLocked,
    clearPreparedPermission,
    syncWithSelection,
    confirmPreparedPermission,
    openContinueElsewhere,
    confirmContinueElsewhere,
    handleRecapture,
    handleContinueRecording,
    continuationMode,
    insertAfterEntryId,
    setContinuationMode,
  } = usePermissionFlow({
    sessionId,
    operationActive,
    whenIdle: operations.idle,
    flushDescriptions,
    requireSelectedEntry,
    setOperationError,
    entryMode: (afterEntryId) => {
      const followed = afterEntryId === undefined ? entries.at(-1) : entries.find((entry) => entryId(entry) === afterEntryId);
      return followed?.kind === 'group' ? 'snapshot' : 'steps';
    },
  });

  /** The section being named; the rail seam, the stage and a heading's menu all open the same dialog. */
  const [sectionDialog, setSectionDialog] = useState<SectionDialogRequest | null>(null);
  const {
    selectedEntry,
    selectedEntryId,
    selectedIndex,
    setSelectedEntryId,
    setZoomOpen,
    selectEntry,
    zoomOpen,
  } = useEditorEntryWorkspace({
    entries,
    flushDescriptions,
    isSelectionBlocked: () => permissionPending || continueElsewherePending,
    onSelectionInteraction: () => {
      if (isPermissionFlowLocked()) clearPreparedPermission();
    },
    onSelectionSaved: () => setOperationError(null),
  });

  useEffect(() => {
    syncWithSelection(selectedEntryId, sessionId);
  }, [syncWithSelection, selectedEntryId, sessionId]);

  // The two halves of "there is only ever one editor tab": register this page
  // with the background, and answer its handoff when asked to open a Project already open here.
  useExtensionPageRegistration();
  useAutoFolderBackup();
  useEditorHandoff({ viewedSessionId: sessionId, flushDescriptions, selectEntry });

  // A lightbox with no entry to show must not stay armed, or it would pop open
  // unexpectedly once entries reappear (e.g. after a deletion or Project reload).
  useEffect(() => {
    if (!selectedEntry) setZoomOpen(false);
  }, [selectedEntry, setZoomOpen]);

  const { undoAction, offeredUndo, offerUndo, takeUndo, returnUndo, finalizeUndo, clearUndo } = useProjectUndo({
    project,
    operationActive,
    projectDeleted,
  });

  useEffect(() => {
    const result = recording.recaptureResult;
    if (!result || result.sessionId !== sessionId || handledRecaptureResult.current === result.runId) return;
    handledRecaptureResult.current = result.runId;
    // The replaced image reaches the screen through the change broadcast like any other write.
    setSelectedEntryId(result.entryId);
    setZoomOpen(false);
    setOperationError(result.status === 'failed' ? result.message ?? t().editor.recaptureFailed : null);
    if (result.status === 'replaced') {
      toast.success(t().editor.recaptureReplaced);
    } else if (result.status === 'cancelled') {
      toast(t().editor.recaptureCancelled);
    }
    void ackStepRecaptureResult(result.runId, result.sessionId).catch((ackError) => {
      console.warn('[howbeam] failed to acknowledge the recapture result', ackError);
    });
  }, [recording.recaptureResult, sessionId, setSelectedEntryId, setZoomOpen]);

  async function flushDescriptions(): Promise<void> {
    try {
      await flushAll();
    } catch (saveError) {
      // A failed save may mean the Project was deleted elsewhere; a fresh read shows it read-only when it was.
      requestReload();
      console.error('[howbeam] failed to save descriptions before an editor operation', saveError);
      // A pending draft confirmation carries its own user-facing message; only
      // genuine save failures get the generic retry wording.
      setOperationError(
        saveError instanceof DraftConfirmationRequiredError
          ? saveError.message
          : t().editor.descriptionSaveRetry,
      );
      throw saveError;
    }
  }

  /** Leaving the tab for another page is safe only once every description is
   * saved; a failure is already in the banner, so the editor just stays. */
  async function leaveEditor(): Promise<boolean> {
    // Nothing can be saved into a deleted Project; its drafts stay journaled.
    if (projectDeleted) return true;
    try {
      await flushDescriptions();
      return true;
    } catch {
      return false;
    }
  }

  /** The Project can't be changed at all: it is gone, being recorded, or a permission flow holds it. */
  function editingBlocked(): boolean {
    return projectDeleted || operationActive || isPermissionFlowLocked();
  }

  function requireSelectedEntry(expectedEntryId?: string): StepEntry {
    if (!selectedEntry || (expectedEntryId !== undefined && expectedEntryId !== entryId(selectedEntry))) {
      throw new Error(t().editor.selectedEntryMissing);
    }
    return selectedEntry;
  }

  // `selectEntry` propagates genuine save failures (it swallows only the
  // pending-confirmation case); fill the banner only when nothing else already surfaced one.
  function selectEntrySafely(id: string): void {
    void selectEntry(id).catch((selectionError) => {
      console.error('[howbeam] failed to switch steps', selectionError);
      setOperationError((current) => current ?? t().editor.selectFailed);
    });
  }

  const {
    handleReorderEntries,
    handleReorderAnnotations,
    deleteEntry,
    handleDeleteAnnotation,
    setEntriesNumbered,
    addSection,
    renameSection,
    deleteSection,
    handleUndo,
  } = useProjectMutations({
    sessionId,
    project,
    entries,
    sections,
    selectedEntryId,
    runOperation: operations.run,
    editingBlocked,
    showOptimistic,
    flushDescriptions,
    adoptCommitted,
    requireSelectedEntry,
    setSelectedEntryId,
    setZoomOpen,
    setOperationError,
    undoAction,
    offeredUndo,
    offerUndo,
    takeUndo,
    returnUndo,
    finalizeUndo,
    clearUndo,
  });

  /** Shared shape of the two recapture controls: resolve the live run id,
   * send the typed control message, and surface any failure in the dialog. */
  async function runRecaptureControl(
    label: string,
    send: (runId: string) => Promise<FocusStepRecaptureSourceResult | CancelStepRecaptureResult>,
    fallback: string,
  ): Promise<void> {
    const runId = recording.recapture?.runId;
    if (!runId) return;
    try {
      const result = await send(runId);
      if (!result.ok) setOperationError(result.error ?? fallback);
    } catch (error) {
      setOperationError(reportError(label, error, fallback));
    }
  }

  const focusRecaptureSource = () =>
    runRecaptureControl('[howbeam] failed to focus the recapture tab', focusStepRecaptureSource, t().editor.recaptureTabMissing);

  const cancelRecapture = () =>
    runRecaptureControl('[howbeam] failed to cancel recapture', cancelStepRecapture, t().editor.recaptureCancelFailed);

  /** Runs an export as one queued operation, so the Project can't change under it
   * and editing shows as locked while it runs. */
  function runExport<T>(task: () => Promise<T>): Promise<T> {
    if (editingBlocked()) return Promise.reject(new EditingBlockedError());
    return operations.run(null, async () => {
      setExporting(true);
      try {
        return await task();
      } finally {
        setExporting(false);
      }
    });
  }

  /** Runs inside the export's queued turn. */
  async function publicationEntries(signal: AbortSignal) {
    if (!sessionId) throw new Error(t().editor.publishTargetMissing);
    await flushDescriptions();
    throwIfAborted(signal);
    const snapshot = await reload();
    if (!snapshot) throw new Error(t().editor.publishTargetMissing);
    throwIfAborted(signal);
    return {
      entries: snapshot.entries,
      metadata: {
        title: projectDisplayTitle(snapshot.project.title),
        description: snapshot.project.description,
        filename: projectDisplayTitle(snapshot.project.title),
        sections: snapshot.project.sections,
      },
    };
  }

  async function setSelectedEntryNumbered(id: string, numbered: boolean): Promise<void> {
    requireSelectedEntry(id);
    await setEntriesNumbered([id], numbered);
  }

  async function exportImages(signal: AbortSignal) {
    const publication = await publicationEntries(signal);
    const stepsToExport = publication.entries.flatMap((entry) =>
      entry.kind === 'single' ? [entry.step] : [entry.anchor, ...entry.annotations],
    );
    return exportImagesAsZip(stepsToExport, undefined, signal);
  }

  // Rejects instead of reporting through `operationError`: the caller's input
  // must roll back to the stored value, so it needs the failure directly.
  async function updateProjectMetadata(changes: ProjectMetadataChanges): Promise<void> {
    if (!project || projectDeleted) throw new Error(t().editor.editTargetMissing);
    if (editingBlocked()) throw new Error(t().editor.editBusy);
    const projectId = project.id;
    await operations.run(null, async () => {
      try {
        adoptProject(await updateProject(projectId, changes));
      } catch (updateError) {
        if (updateError instanceof ProjectNotFoundError) requestReload();
        throw updateError;
      }
    });
  }

  // Queued edits never lock the screen; only an export does, once it proves slow.
  const exportShown = useDeferredBusy(exporting);
  const loadingShown = useDeferredBusy(projectLoadState === 'loading');
  const editingLocked = projectDeleted || exportShown || permissionFlowActive;

  useBusyNotice(operations.running?.label ?? null);
  useUndoNotice({
    action: undoAction,
    pending: operations.running !== null,
    onUndo: () => void handleUndo(),
    onDismiss: clearUndo,
  });

  return (
    // The editor's layout numbers, read by the stage, the step rail and the notices alike: the content gutter,
    // the step strip fixed along the bottom below lg, and the room the stage keeps clear for notices.
    <div className={`flex h-screen flex-col [--content-gutter:1rem] sm:[--content-gutter:1.5rem] lg:[--content-gutter:2.5rem] [--step-rail-height:8rem] [--notice-lane:5rem] ${entries.length > 0 ? 'max-lg:[--bottom-bar-height:var(--step-rail-height)]' : ''}`}>
      <AppToaster />
      <EditorHeader
        operationActive={operationActive}
        editingDisabled={editingLocked}
        operation={recording.operation}
        hasSteps={entries.length > 0}
        projectTitle={project?.title ?? null}
        projectActionsAvailable={projectLoadState !== 'missing' && !projectDeleted}
        beforeNavigate={leaveEditor}
        onShowRecording={ordinaryRecordingActive && recording.tabId != null ? () => void showRecordedTab(recording.tabId!) : undefined}
        publish={{
          runExport,
          getProjectEntries: publicationEntries,
          metadata: {
            title: project ? projectDisplayTitle(project.title) : undefined,
            description: project?.description,
            filename: project ? projectDisplayTitle(project.title) : undefined,
            sections: project?.sections,
          },
          onExportImages: exportImages,
        }}
      />
      <RecaptureProgressDialog
        open={recaptureActive}
        phase={recording.recapture?.phase ?? 'awaiting-target'}
        error={recaptureActive ? operationError : null}
        onFocusSource={() => void focusRecaptureSource()}
        onCancel={() => void cancelRecapture()}
      />
      <SourcePermissionDialog
        open={preparedPermission !== null}
        sourceOrigin={preparedPermission?.source.kind === 'origin' ? preparedPermission.source.sourceOrigin : ''}
        actionLabel={preparedPermission?.action.kind === 'continuation' ? t().editor.continuationAction : t().editor.recaptureAction}
        pending={permissionPending}
        onContinueElsewhere={
          preparedPermission?.action.kind === 'continuation'
            ? () => void openContinueElsewhere()
            : undefined
        }
        continueElsewherePending={continueElsewherePending}
        continueElsewhereError={continueElsewhereError}
        continuationTabs={continuationTabs}
        selectedContinuationTabId={selectedContinuationTabId}
        onSelectContinuationTab={selectContinuationTab}
        onConfirmContinueElsewhere={() => void confirmContinueElsewhere()}
        sourceUnavailableReason={
          preparedPermission?.source.kind === 'unavailable' ? preparedPermission.source.reason : null
        }
        insertAfterStep={
          insertAfterEntryId === undefined ? undefined : entries.findIndex((entry) => entryId(entry) === insertAfterEntryId) + 1 || undefined
        }
        continuationMode={preparedPermission?.action.kind === 'continuation' ? continuationMode : undefined}
        onContinuationModeChange={setContinuationMode}
        onCancel={clearPreparedPermission}
        onConfirm={() => void confirmPreparedPermission()}
      />
      {projectDeleted && projectLoadState !== 'missing' && (
        <div className="border-b-2 border-border bg-card px-3 py-3 sm:px-7">
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>
              <span>{t().editor.projectDeleted}</span>
              <Button variant="outline" size="sm" className="mt-2 w-fit" onClick={() => void openLibrary()}>
                <Library />{t().common.backToLibrary}
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      )}
      {(error || dataError || (operationError && !recaptureActive)) && (
        <div className="border-b-2 border-border bg-card px-3 py-3 sm:px-7">
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{error ?? dataError ?? operationError}</AlertDescription>
          </Alert>
        </div>
      )}
      <div className="flex min-h-0 flex-1 pb-[var(--step-rail-height,8rem)] lg:pb-0">
        {projectLoadState === 'loading' ? (
          // A quick first read shows nothing here rather than a message that is gone at once.
          <main role={loadingShown ? 'status' : undefined} className="flex min-w-0 flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
            {loadingShown && t().editor.loading}
          </main>
        ) : projectLoadState === 'missing' ? (
          <main className="flex min-w-0 flex-1 items-center justify-center p-8 text-center">
            <div className="flex max-w-md flex-col items-center text-muted-foreground">
              <Mascot className="mb-4 size-16" />
              <h2 className="text-lg font-bold text-foreground">{t().editor.missingTitle}</h2>
              <p className="mt-2 text-sm leading-relaxed">
                {viewedSessionId
                  ? t().editor.missingDeleted
                  : t().editor.missingId}
              </p>
              <Button variant="outline" className="mt-5" onClick={() => void openLibrary()}>
                <Library />{t().common.backToLibrary}
              </Button>
            </div>
          </main>
        ) : projectLoadState === 'invalid' ? (
          <main className="flex min-w-0 flex-1 items-center justify-center p-8 text-center">
            <div className="flex max-w-md flex-col items-center text-muted-foreground">
              <span className="mb-4 flex size-14 items-center justify-center rounded-full border-2 border-border bg-warning-soft">
                <AlertCircle className="size-6 text-foreground" aria-hidden="true" />
              </span>
              <h2 className="text-lg font-bold text-foreground">{t().editor.invalidTitle}</h2>
              <p className="mt-2 text-sm leading-relaxed">
                {t().editor.invalidBody}
              </p>
            </div>
          </main>
        ) : entries.length === 0 ? (
          <EmptyState isRecording={ordinaryRecordingActive} recordingTabId={tabId} />
        ) : (
          <>
            <StepRail
              entries={entries}
              selectedEntryId={selectedEntryId}
              sections={sections}
              onSelect={selectEntrySafely}
              onRenameSection={(sectionId) => {
                const section = sections.find((candidate) => candidate.id === sectionId);
                if (section) setSectionDialog({ kind: 'rename', sectionId, title: section.title });
              }}
              onDeleteSection={deleteSection}
              onStartSection={(startEntryId) => setSectionDialog({
                kind: 'add',
                startEntryId,
                step: entries.findIndex((entry) => entryId(entry) === startEntryId) + 1,
              })}
              onReorder={handleReorderEntries}
              onContinueRecording={(afterEntryId) => void handleContinueRecording(afterEntryId)}
              reorderDisabled={operationActive || editingLocked}
            />
            {selectedEntry ? (
              <StepStage
                key={entryId(selectedEntry)}
                entry={selectedEntry}
                index={selectedIndex}
                sectionTitle={sectionOfEntry(sections, entries, selectedIndex)?.title}
                onStartSection={
                  sections.some((section) => section.startEntryId === entryId(selectedEntry))
                    ? undefined
                    : () => setSectionDialog({ kind: 'add', startEntryId: entryId(selectedEntry), step: selectedIndex + 1 })
                }
                projectTitle={project?.title}
                onTitleChange={(title) => updateProjectMetadata({ title })}
                onDelete={deleteEntry}
                onDeleteAnnotation={handleDeleteAnnotation}
                // The undo notice would sit on top of the full-screen views; a pending undo ends there.
                onZoom={() => {
                  clearUndo();
                  setZoomOpen(true);
                }}
                onEditImage={clearUndo}
                onReorderAnnotations={(reordered) => handleReorderAnnotations(entryId(selectedEntry), reordered)}
                onRecapture={handleRecapture}
                onSetNumbered={setSelectedEntryNumbered}
                editingDisabled={operationActive || editingLocked}
              />
            ) : (
              <main className="flex min-w-0 flex-1 items-center justify-center p-8 pb-36 text-center lg:pb-8">
                <div className="max-w-sm text-muted-foreground">
                  <h2 className="text-lg font-bold text-foreground">{t().editor.noSelectionTitle}</h2>
                  <p className="mt-2 text-sm">{t().editor.noSelectionBody}</p>
                </div>
              </main>
            )}
          </>
        )}
      </div>
      <Lightbox
        entries={entries}
        index={zoomOpen ? selectedIndex : null}
        onClose={() => setZoomOpen(false)}
        onNavigate={(entry) => selectEntrySafely(entryId(entry))}
      />
      <SectionTitleDialog
        request={sectionDialog}
        onClose={() => setSectionDialog(null)}
        onSubmit={async (request, title) => {
          if (request.kind === 'add') {
            await addSection(request.startEntryId, title);
            // Selecting the new section's first step scrolls the rail to its heading.
            selectEntrySafely(request.startEntryId);
          } else {
            await renameSection(request.sectionId, title);
          }
          setSectionDialog(null);
        }}
      />
    </div>
  );
}

export default function App() {
  return (
    <EditorSaveProvider>
      <EditorApp />
    </EditorSaveProvider>
  );
}
