import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  Archive,
  Copy,
  Loader2,
  PencilLine,
  Plus,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { createProjectFromSteps, deleteProjectPermanently, duplicateProject, getProjectSummaries, updateProject } from '@/lib/storage/project-repository';
import { getSteps } from '@/lib/storage/step-repository';
import { getProjectStructureSnapshot } from '@/lib/storage/project-structure';
import { type ProjectSummary, type StepEntry } from '@/lib/storage/models';
import { clearSelectedProject, createAndSelectProject, openSelectedProjectInEditor } from '@/lib/project/project-actions';
import { subscribeProjectsChanged } from '@/lib/storage/change-notifier';
import { getRecordingState, onRecordingStateChange } from '@/lib/storage/storage';
import { Button } from '@/components/ui/button';
import { DashedOutline } from '@/components/ui/dashed-outline';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Alert, AlertDescription } from '@/components/ui/alert';
import AppToaster from '@/components/shared/AppToaster';
import ConfirmationDialog from '@/components/shared/ConfirmationDialog';
import EditableTitle from '@/components/shared/EditableTitle';
import AppHeader from '@/components/shared/AppHeader';
import Mascot from '@/components/shared/Mascot';
import LazyPreview from '@/components/shared/LazyPreview';
import EntryThumbnail from '@/components/editor/EntryThumbnail';
import BackupPausedNotice from '@/components/shared/BackupPausedNotice';
import { useAutoFolderBackup } from '@/lib/backup/use-folder-backup';
import { reportError } from '@/components/shared/report-error';
import { usePendingAction } from '@/components/shared/use-pending-action';
import { useDeferredBusy } from '@/lib/shared/use-deferred-busy';
import { PERSISTED_PROJECT_LIMITS } from '@/lib/storage/persistence-limits';
import { intlLocale, t } from '@/lib/shared/i18n';
import { exportProjectArchive } from '@/lib/export/project-archive-serialize';
import { importProjectArchive } from '@/lib/export/project-archive-import';
import { PROJECT_ARCHIVE_LIMITS, ProjectArchiveError } from '@/lib/export/project-archive-contract';
import { projectExportFilename } from '@/lib/export/project-export-contract';
import { downloadBlobViaBrowser } from '@/lib/export/download-utils';
import { useExtensionPageRegistration } from '@/lib/runtime/use-extension-page-registration';

/** Derives the .howbeam archive name from the same stem the publication
 * exporters use; strips the extension the (unexported) stem helper's facade appends. */
function exportFilename(title: string): string {
  const stem = projectExportFilename({ title }, 'html').replace(/\.html$/, '');
  return `${stem}.howbeam`;
}

/** The project's first step, so a card can be recognised at a glance. */
function ProjectCover({ project }: { project: ProjectSummary }) {
  return (
    <div className="aspect-[16/9] w-full shrink-0 overflow-hidden border-b-2 border-border bg-secondary">
      {project.entryCount > 0 && (
        <LazyPreview eager={false}>
          <FirstEntry projectId={project.id} revision={`${project.contentRevision}:${project.stepEditRevision}`} />
        </LazyPreview>
      )}
    </div>
  );
}

function FirstEntry({ projectId, revision }: { projectId: string; revision: string }) {
  const [entry, setEntry] = useState<StepEntry | null>(null);
  useEffect(() => {
    let active = true;
    getProjectStructureSnapshot(projectId)
      .then((snapshot) => { if (active) setEntry(snapshot.entries[0] ?? null); })
      .catch((error) => console.warn('[howbeam] failed to read the project cover', error));
    return () => { active = false; };
  }, [projectId, revision]);
  return entry && <EntryThumbnail entry={entry} alt="" fit="cover" loading="lazy" decoding="async" className="size-full" />;
}

export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [loading, setLoading] = useState(true);
  const loadingShown = useDeferredBusy(loading);
  const { pendingKey: pendingId, shownKey: shownId, runExclusive } = usePendingAction<string>();
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);
  const [exportTarget, setExportTarget] = useState<ProjectSummary | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [operationLocked, setOperationLocked] = useState(false);

  async function refresh(options: { showLoading?: boolean } = {}) {
    const showLoading = options.showLoading ?? true;
    if (showLoading) setLoading(true);
    try {
      const [nextProjects, state] = await Promise.all([getProjectSummaries(), getRecordingState()]);
      setProjects(nextProjects);
      setOperationLocked(state.operation !== null || state.isRecording);
    } catch (refreshError) {
      console.error('[howbeam] failed to load project library', refreshError);
      setError(t().library.loadFailed);
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  // Lets "回到專案庫" reuse this tab instead of opening a second library.
  useExtensionPageRegistration();
  useAutoFolderBackup();

  useEffect(() => {
    void refresh();
    // Projects change from other surfaces (editor edits, recording, popup resets, another
    // library tab): the change broadcast keeps a visible library live, and focus/visibility
    // cover a tab that missed it while hidden.
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') void refresh({ showLoading: false });
    };
    window.addEventListener('focus', refreshIfVisible);
    document.addEventListener('visibilitychange', refreshIfVisible);
    const unsubscribeProjects = subscribeProjectsChanged(refreshIfVisible);
    const unsubscribe = onRecordingStateChange((state) => {
      setOperationLocked(state.operation !== null || state.isRecording);
    });
    return () => {
      window.removeEventListener('focus', refreshIfVisible);
      document.removeEventListener('visibilitychange', refreshIfVisible);
      unsubscribe();
      unsubscribeProjects();
    };
  }, []);

  const visibleProjects = useMemo(() => {
    const normalized = deferredQuery.trim().toLocaleLowerCase(intlLocale());
    return projects.filter((project) => {
      return !normalized || `${project.title}\n${project.description}`.toLocaleLowerCase(intlLocale()).includes(normalized);
    });
  }, [deferredQuery, projects]);

  async function run(id: string, action: () => Promise<void>, options: { refreshAfter?: boolean } = {}) {
    if (loading || operationLocked) return false;
    // The shared gate answers synchronously, so two actions fired in the same
    // event turn cannot overlap storage writes.
    const outcome = await runExclusive(id, async () => {
      setError(null);
      try {
        await action();
        if (options.refreshAfter !== false) await refresh({ showLoading: false });
        return true;
      } catch (operationError) {
        const reason = reportError('[howbeam] library operation failed', operationError, t().library.operationFailed);
        // Archive diagnostics are English; show the localized copy for their code.
        setError(operationError instanceof ProjectArchiveError ? t().library.archiveErrors[operationError.code] : reason);
        return false;
      }
    });
    return outcome ?? false;
  }

  async function createNewProject() {
    await run('new', async () => {
      const project = await createAndSelectProject();
      await openSelectedProjectInEditor(project.id, { inPlace: true });
    });
  }

  async function exportProject(project: ProjectSummary) {
    await run(project.id, async () => {
      const blob = await exportProjectArchive(await getSteps(project.id), {
        metadata: {
          title: project.title,
          description: project.description,
          sections: project.sections,
        },
      });
      // Keeps the object URL alive until the download settles; a download that
      // never starts rejects into the page-level alert below.
      await downloadBlobViaBrowser(blob, exportFilename(project.title));
      toast.success(t().library.exportStarted(project.title));
    }, { refreshAfter: false });
    // A failed export reports through the page-level live alert. Close the
    // modal so it does not aria-hide that alert from assistive technology.
    setExportTarget(null);
  }

  async function deleteProject(target: ProjectSummary) {
    await run(target.id, async () => {
      // Only clear the UI selection after the durable delete succeeds, and
      // compare-and-clear so a newer selection isn't erased by this older action.
      await deleteProjectPermanently(target.id);
      await clearSelectedProject(target.id);
    });
    // Mirrors the export flow: a failed delete reports through the page-level live
    // alert, so close the modal rather than leave the message aria-hidden behind it.
    setDeleteTarget(null);
  }

  async function importProjectFile(file: File) {
    if (file.size > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes) {
      setError(t().library.importTooLarge);
      return;
    }
    await run('import', async () => {
      const imported = await importProjectArchive(file);
      const fallbackTitle = file.name.replace(/\.howbeam$/i, '') || t().library.importedFallbackTitle;
      const project = await createProjectFromSteps(
        imported.steps,
        {
          title: imported.metadata.title || fallbackTitle,
          description: imported.metadata.description,
        },
        { sections: imported.metadata.sections },
      );
      await openSelectedProjectInEditor(project.id, { inPlace: true });
    });
  }

  return (
    // The page's layout numbers, read by its content and by the notices: the content gutter and the room kept clear for notices.
    <div className="min-h-screen bg-background text-foreground [--content-gutter:1rem] sm:[--content-gutter:2rem] [--notice-lane:5rem]">
      <AppToaster />
      <AppHeader
        actions={
          <>
            <input
              ref={importInput}
              type="file"
              className="sr-only"
              // Triggered by the visible Import button; left in the tab order and
              // the accessibility tree it would be an unlabeled first stop.
              tabIndex={-1}
              aria-hidden="true"
              accept=".howbeam,application/vnd.howbeam.project+zip"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.currentTarget.value = '';
                if (file) void importProjectFile(file);
              }}
            />
            {/* Icon always shows; label appears from `sm` up, like the editor's actions. */}
            <Button
              variant="outline"
              aria-label={t().library.import}
              className="px-2.5 sm:px-3.5"
              onClick={() => importInput.current?.click()}
              disabled={loading || operationLocked || shownId !== null}
            >
              {shownId === 'import' ? <Loader2 className="animate-spin" /> : <Upload />}
              <span className="hidden sm:inline">{t().library.import}</span>
            </Button>
            <Button
              variant="default"
              aria-label={t().library.create}
              className="px-2.5 sm:px-3.5"
              onClick={() => void createNewProject()}
              disabled={loading || operationLocked || shownId !== null}
            >
              {shownId === 'new' ? <Loader2 className="animate-spin" /> : <Plus />}
              <span className="hidden sm:inline">{t().library.create}</span>
            </Button>
          </>
        }
      />

      {/* Full-width like every page under the shared header, so the content
          shares its gutter; the project grid fills columns by a minimum card
          width instead of breakpoints. */}
      <main className="flex flex-col px-[var(--content-gutter,1rem)] pt-6 pb-[var(--notice-lane,5rem)]">
        <h1 className="mb-5 text-2xl leading-tight font-bold text-foreground">{t().library.title}</h1>
        <BackupPausedNotice />
        {operationLocked && (
          <Alert className="mb-4">
            <AlertDescription>{t().library.lockedNotice}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive" className="mb-4"><AlertDescription>{error}</AlertDescription></Alert>
        )}

          {/* The field draws the outline, so focus is shown on the whole box. */}
          <div className="mb-6 flex h-11 min-w-0 items-center gap-2.5 rounded-md border-2 border-border bg-card px-3.5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus">
            <Search className="size-[18px] shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t().library.searchPlaceholder}
              aria-label={t().library.searchLabel}
              maxLength={120}
              className="min-w-0 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>

        {loading ? (
          // A quick first read shows nothing here rather than a spinner that is gone at once.
          <div role={loadingShown ? 'status' : undefined} className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
            {loadingShown && <><Loader2 className="mr-2 size-5 animate-spin" />{t().library.loading}</>}
          </div>
        ) : visibleProjects.length === 0 ? (
          <div className="relative flex min-h-72 flex-col items-center justify-center gap-2 rounded-md bg-card px-6 py-10 text-center">
            <DashedOutline radius={8} />
            <Mascot className="mb-2 size-16" />
            <h2 className="text-lg font-bold">{query ? t().library.noMatches : t().library.empty}</h2>
            <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
              {query ? t().library.noMatchesHint : t().library.emptyHint}
            </p>
            {!query && (
              <Button className="mt-3" onClick={() => void createNewProject()}><Plus />{t().library.create}</Button>
            )}
          </div>
        ) : (
          <ul className="grid auto-rows-fr grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-4">
            {visibleProjects.map((project) => {
              const pending = shownId === project.id;
              // While any operation is in flight, `run` rejects further actions;
              // disabling the other cards makes that lock visible instead of a silent no-op.
              const actionsLocked = operationLocked || shownId !== null;
              const otherActionPending = shownId !== null && !pending;
              const lockedTitle = (title: string) => (otherActionPending ? t().library.otherActionPending : title);
              return (
                <li
                  key={project.id}
                  className="group flex flex-col overflow-hidden rounded-md border-2 border-border bg-card transition-transform duration-200 hover:-translate-y-0.5"
                >
                  <ProjectCover project={project} />
                  <div className="flex flex-1 flex-col gap-2.5 p-4">
                    <EditableTitle
                      value={project.title}
                      maxLength={PERSISTED_PROJECT_LIMITS.maxTitleLength}
                      fallback={t().common.untitledProject}
                      label={t().library.titleLabel}
                      disabled={actionsLocked}
                      // `run` reports the reason via the page-level alert and returns
                      // false on failure; rejecting here rolls the field back to the stored title.
                      onCommit={async (title) => {
                        const saved = await run(project.id, async () => { await updateProject(project.id, { title }); });
                        if (!saved) throw new Error('Project rename was not applied.');
                      }}
                      className="-ml-1.5 w-full rounded-md border-2 border-transparent px-1 py-0.5 text-base leading-snug font-bold text-foreground focus-ring hover:border-border-soft focus:border-border focus:bg-background disabled:opacity-70"
                    />
                    {project.description && (
                      <p className="line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">
                        {project.description}
                      </p>
                    )}
                    <p className="text-xs font-bold text-muted-foreground">{t().library.stepCount(project.entryCount)}</p>
                    <div className="flex-1" />
                    <div className="mt-1 flex items-center gap-1 border-t-2 border-border-soft pt-3">
                      <Button
                        size="sm"
                        className="min-w-0 flex-1"
                        onClick={() => void run(project.id, () => openSelectedProjectInEditor(project.id, { inPlace: true }))}
                        disabled={actionsLocked}
                      >
                        {pending ? <Loader2 className="animate-spin" /> : <PencilLine />}{t().common.open}
                      </Button>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-8 shrink-0"
                            aria-label={t().common.duplicate}
                            onClick={() => void run(project.id, async () => { await duplicateProject(project.id); })}
                            disabled={actionsLocked}
                          >
                            <Copy />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{lockedTitle(t().common.duplicate)}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-8 shrink-0"
                            aria-label={t().library.exportProjectLabel(project.title)}
                            onClick={() => setExportTarget(project)}
                            disabled={actionsLocked}
                          >
                            <Archive />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{lockedTitle(t().library.exportArchiveTooltip)}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-8 shrink-0 hover:bg-danger-soft hover:text-danger"
                            aria-label={t().common.delete}
                            onClick={() => setDeleteTarget(project)}
                            disabled={actionsLocked}
                          >
                            <Trash2 />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{lockedTitle(t().common.delete)}</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>

      <ConfirmationDialog
        open={exportTarget !== null}
        title={t().library.exportDialogTitle}
        description={exportTarget
          ? t().library.exportDialogDescription(exportFilename(exportTarget.title))
          : ''}
        confirmLabel={t().library.exportDialogConfirm}
        confirmVariant="default"
        pendingLabel={t().library.exportDialogPending}
        pending={exportTarget ? pendingId === exportTarget.id : false}
        onOpenChange={(open) => { if (!open) setExportTarget(null); }}
        onConfirm={() => { if (exportTarget) void exportProject(exportTarget); }}
      />

      <ConfirmationDialog
        open={deleteTarget !== null}
        title={t().library.deleteDialogTitle}
        description={t().library.deleteDialogDescription}
        confirmLabel={t().library.deleteDialogConfirm}
        pending={deleteTarget ? pendingId === deleteTarget.id : false}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        onConfirm={() => { if (deleteTarget) void deleteProject(deleteTarget); }}
      />
    </div>
  );
}
