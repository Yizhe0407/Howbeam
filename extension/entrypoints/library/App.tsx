import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { ArchiveRestore, Layers, Loader2, Search } from 'lucide-react';
import { createProjectFromSteps, deleteProjectPermanently, duplicateProject, getProjectSummaries, updateProject } from '@/lib/storage/project-repository';
import { getSteps } from '@/lib/storage/step-repository';
import { projectDisplayTitle, type ProjectSummary } from '@/lib/storage/models';
import { clearSelectedProject, openSelectedProjectInEditor } from '@/lib/project/project-actions';
import { subscribeProjectsChanged, subscribeSeriesChanged } from '@/lib/storage/change-notifier';
import {
  addProjectToSeries,
  createSeries,
  deleteSeries,
  getAllSeries,
  removeProjectFromSeries,
  renameSeries,
  reorderSeries,
} from '@/lib/storage/series-repository';
import type { ProjectSeries } from '@/lib/storage/series-model';
import { buildLibraryItems, libraryItemMatches, type SeriesWithProjects } from '@/lib/project/library-items';
import { getRecordingState, onRecordingStateChange } from '@/lib/storage/storage';
import { Button } from '@/components/ui/button';
import { DashedOutline } from '@/components/ui/dashed-outline';
import { Alert, AlertDescription } from '@/components/ui/alert';
import AppToaster from '@/components/shared/AppToaster';
import ConfirmationDialog from '@/components/shared/ConfirmationDialog';
import AppHeader from '@/components/shared/AppHeader';
import PageHeading from '@/components/shared/PageHeading';
import Mascot from '@/components/shared/Mascot';
import BackupPausedNotice from '@/components/shared/BackupPausedNotice';
import { useAutoFolderBackup } from '@/lib/backup/use-folder-backup';
import { reportError } from '@/components/shared/report-error';
import { usePendingAction } from '@/components/shared/use-pending-action';
import { useDeferredBusy } from '@/lib/shared/use-deferred-busy';
import { intlLocale, t } from '@/lib/shared/i18n';
import { exportProjectArchive } from '@/lib/export/project-archive-serialize';
import { importProjectArchive } from '@/lib/export/project-archive-import';
import { PROJECT_ARCHIVE_LIMITS, ProjectArchiveError } from '@/lib/export/project-archive-contract';
import { projectExportFilename } from '@/lib/export/project-export-contract';
import { downloadBlobViaBrowser } from '@/lib/export/download-utils';
import { useExtensionPageRegistration } from '@/lib/runtime/use-extension-page-registration';
import ProjectCard from './ProjectCard';
import SeriesCard from './SeriesCard';
import SeriesView from './SeriesView';
import AddToSeriesDialog from './AddToSeriesDialog';
import { useSeriesRoute } from './use-series-route';

/** Derives the .howbeam archive name from the same stem the publication
 * exporters use; strips the extension the (unexported) stem helper's facade appends. */
function exportFilename(title: string): string {
  const stem = projectExportFilename({ title }, 'html').replace(/\.html$/, '');
  return `${stem}.howbeam`;
}

export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [series, setSeries] = useState<ProjectSeries[]>([]);
  const { seriesId, openSeries, closeSeries, dropSeries } = useSeriesRoute();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const editedAt = useMemo(() => new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' }), []);
  const [loading, setLoading] = useState(true);
  const loadingShown = useDeferredBusy(loading);
  const { pendingKey: pendingId, shownKey: shownId, runExclusive } = usePendingAction<string>();
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);
  const [exportTarget, setExportTarget] = useState<ProjectSummary | null>(null);
  const [seriesTarget, setSeriesTarget] = useState<ProjectSummary | null>(null);
  const [dissolveTarget, setDissolveTarget] = useState<ProjectSeries | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [operationLocked, setOperationLocked] = useState(false);

  async function refresh(options: { showLoading?: boolean } = {}) {
    const showLoading = options.showLoading ?? true;
    if (showLoading) setLoading(true);
    try {
      const [nextProjects, nextSeries, state] = await Promise.all([getProjectSummaries(), getAllSeries(), getRecordingState()]);
      setProjects(nextProjects);
      setSeries(nextSeries);
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
    const unsubscribeSeries = subscribeSeriesChanged(refreshIfVisible);
    const unsubscribe = onRecordingStateChange((state) => {
      setOperationLocked(state.operation !== null || state.isRecording);
    });
    return () => {
      window.removeEventListener('focus', refreshIfVisible);
      document.removeEventListener('visibilitychange', refreshIfVisible);
      unsubscribe();
      unsubscribeProjects();
      unsubscribeSeries();
    };
  }, []);

  const items = useMemo(() => buildLibraryItems(projects, series), [projects, series]);
  const visibleItems = useMemo(() => {
    const normalize = (text: string) => text.toLocaleLowerCase(intlLocale());
    const normalized = normalize(deferredQuery.trim());
    return items.filter((item) => libraryItemMatches(item, normalized, normalize));
  }, [deferredQuery, items]);
  const allSeries = useMemo(
    () => items.flatMap((item): SeriesWithProjects[] => (item.kind === 'series' ? [item] : [])),
    [items],
  );
  const standaloneProjects = useMemo(
    () => items.flatMap((item) => (item.kind === 'project' ? [item.project] : [])),
    [items],
  );
  const openEntry = seriesId === null ? null : allSeries.find((entry) => entry.series.id === seriesId) ?? null;

  // A Series deleted here or elsewhere leaves its page for the grid.
  useEffect(() => {
    if (!loading && seriesId !== null && !openEntry) dropSeries();
  }, [loading, seriesId, openEntry, dropSeries]);

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
      await downloadBlobViaBrowser(blob, exportFilename(projectDisplayTitle(project.title)));
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
      const project = await createProjectFromSteps(
        imported.steps,
        {
          // Howbeam always writes the title; an empty one is an unnamed project and stays unnamed.
          title: imported.metadata.title,
          description: imported.metadata.description,
        },
        { sections: imported.metadata.sections },
      );
      await openSelectedProjectInEditor(project.id, { inPlace: true });
    });
  }

  const openProject = (projectId: string) => void run(projectId, () => openSelectedProjectInEditor(projectId, { inPlace: true }));
  const renameProject = async (projectId: string, title: string) => {
    await run(projectId, async () => { await updateProject(projectId, { title }); });
  };
  const seriesKey = (id: string) => `series:${id}`;
  const renameSeriesTo = async (id: string, title: string) => {
    await run(seriesKey(id), async () => { await renameSeries(id, title); });
  };

  async function createAndOpenSeries() {
    let createdId: string | null = null;
    await run('series:new', async () => { createdId = (await createSeries()).id; });
    if (createdId) openSeries(createdId);
  }

  function placeInSeries(project: ProjectSummary, target: { seriesId: string } | { title: string }) {
    setSeriesTarget(null);
    void run(project.id, async () => {
      if ('seriesId' in target) await addProjectToSeries(target.seriesId, project.id);
      else await createSeries(target.title, [project.id]);
    });
  }

  async function dissolveSeries(target: ProjectSeries) {
    await run(seriesKey(target.id), () => deleteSeries(target.id));
    // Mirrors delete: a failure reports through the page-level alert, so the modal closes.
    setDissolveTarget(null);
  }

  // While any operation is in flight, `run` rejects further actions;
  // disabling every control makes that lock visible instead of a silent no-op.
  const actionsLocked = operationLocked || shownId !== null;
  /** Tooltip copy for a card whose controls are locked by another card's action. */
  const lockedTitleFor = (key: string) => (title: string) => (shownId !== null && shownId !== key ? t().library.otherActionPending : title);
  const metaFor = (updatedAt: number, detail: string) => `${editedAt.format(updatedAt)} · ${detail}`;

  return (
    // The page's layout numbers, read by its content and by the notices: the content gutter and the room kept clear for notices.
    <div className="min-h-screen bg-background text-foreground [--content-gutter:1rem] sm:[--content-gutter:2rem] [--notice-lane:5rem]">
      <AppToaster />
      <AppHeader
        page="library"
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
            {!openEntry && (
              <Button
                variant="outline"
                aria-label={t().library.series.create}
                className="px-2.5 sm:px-3.5"
                onClick={() => void createAndOpenSeries()}
                disabled={loading || operationLocked || shownId !== null}
              >
                {shownId === 'series:new' ? <Loader2 className="animate-spin" /> : <Layers />}
                <span className="hidden sm:inline">{t().library.series.create}</span>
              </Button>
            )}
            <Button
              variant="outline"
              aria-label={t().library.import}
              className="px-2.5 sm:px-3.5"
              onClick={() => importInput.current?.click()}
              disabled={loading || operationLocked || shownId !== null}
            >
              {shownId === 'import' ? <Loader2 className="animate-spin" /> : <ArchiveRestore />}
              <span className="hidden sm:inline">{t().library.import}</span>
            </Button>
          </>
        }
      />

      {/* Full-width like every page under the shared header, so the content
          shares its gutter; the project grid fills columns by a minimum card
          width instead of breakpoints. */}
      <main className="flex flex-col px-[var(--content-gutter,1rem)] pt-6 pb-[var(--notice-lane,5rem)]">
        {openEntry ? (
          <>
        <BackupPausedNotice />
        {operationLocked && (
          <Alert className="mb-4">
            <AlertDescription>{t().library.lockedNotice}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive" className="mb-4"><AlertDescription>{error}</AlertDescription></Alert>
        )}

            <SeriesView
              entry={openEntry}
              addable={standaloneProjects}
              locked={actionsLocked}
              onBack={closeSeries}
              onRename={(title) => renameSeriesTo(openEntry.series.id, title)}
              onOpenProject={openProject}
              onRenameProject={renameProject}
              onAddProject={(projectId) => run(projectId, async () => { await addProjectToSeries(openEntry.series.id, projectId); })}
              onRemoveProject={(projectId) => void run(projectId, async () => { await removeProjectFromSeries(openEntry.series.id, projectId); })}
              onReorder={(projectIds) => run(seriesKey(openEntry.series.id), async () => { await reorderSeries(openEntry.series.id, projectIds); })}
            />
          </>
        ) : (
          <>
        <PageHeading title={t().library.title} className="mb-5" />
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
        ) : visibleItems.length === 0 ? (
          <div className="relative flex min-h-72 flex-col items-center justify-center gap-2 rounded-md bg-card px-6 py-10 text-center">
            <DashedOutline radius={8} />
            <Mascot className="mb-2 size-16" />
            <h2 className="text-lg font-bold">{query ? t().library.noMatches : t().library.empty}</h2>
            <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
              {query ? t().library.noMatchesHint : t().library.emptyHint}
            </p>
          </div>
        ) : (
          <ul className="grid auto-rows-fr grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-4">
            {visibleItems.map((item) => (item.kind === 'series' ? (
              <SeriesCard
                key={item.series.id}
                entry={item}
                meta={metaFor(item.updatedAt, t().library.series.projectCount(item.projects.length))}
                locked={actionsLocked}
                lockedTitle={lockedTitleFor(seriesKey(item.series.id))}
                onOpen={() => openSeries(item.series.id)}
                onRename={(title) => renameSeriesTo(item.series.id, title)}
                onDissolve={() => setDissolveTarget(item.series)}
              />
            ) : (
              <ProjectCard
                key={item.project.id}
                project={item.project}
                meta={metaFor(item.project.updatedAt, t().library.stepCount(item.project.entryCount))}
                pending={shownId === item.project.id}
                locked={actionsLocked}
                lockedTitle={lockedTitleFor(item.project.id)}
                onOpen={() => openProject(item.project.id)}
                onRename={(title) => renameProject(item.project.id, title)}
                onDuplicate={() => void run(item.project.id, async () => { await duplicateProject(item.project.id); })}
                onAddToSeries={() => setSeriesTarget(item.project)}
                onExport={() => setExportTarget(item.project)}
                onDelete={() => setDeleteTarget(item.project)}
              />
            )))}
          </ul>
        )}
          </>
        )}
      </main>

      <ConfirmationDialog
        open={exportTarget !== null}
        title={t().library.exportDialogTitle}
        description={t().library.exportDialogDescription}
        confirmLabel={t().library.exportDialogConfirm}
        confirmVariant="default"
        pendingLabel={t().library.exportDialogPending}
        pending={exportTarget ? pendingId === exportTarget.id : false}
        onOpenChange={(open) => { if (!open) setExportTarget(null); }}
        onConfirm={() => { if (exportTarget) void exportProject(exportTarget); }}
      />

      <AddToSeriesDialog
        project={seriesTarget}
        series={allSeries}
        onClose={() => setSeriesTarget(null)}
        onAdd={(id) => { if (seriesTarget) placeInSeries(seriesTarget, { seriesId: id }); }}
        onCreate={(title) => { if (seriesTarget) placeInSeries(seriesTarget, { title }); }}
      />

      <ConfirmationDialog
        open={dissolveTarget !== null}
        title={t().library.series.dissolveDialogTitle}
        description={t().library.series.dissolveDialogDescription}
        confirmLabel={t().library.series.dissolveDialogConfirm}
        pending={dissolveTarget ? pendingId === seriesKey(dissolveTarget.id) : false}
        onOpenChange={(open) => { if (!open) setDissolveTarget(null); }}
        onConfirm={() => { if (dissolveTarget) void dissolveSeries(dissolveTarget); }}
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
