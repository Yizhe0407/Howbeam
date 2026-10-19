import { useCallback, useEffect, useState } from 'react';
import { getProject } from '../storage/project-repository';
import { subscribeProjectsChanged } from '../storage/change-notifier';
import { getProjectStructureSnapshot, repairEmptySnapshotAnchors, type ProjectStructureSnapshot } from '../storage/project-structure';
import { getRecordingState } from '../storage/storage';
import { type Project } from '../storage/models';
import { retainScreenshotBlobs } from './retain-screenshot-blobs';

export type EditorProjectLoadState = 'loading' | 'ready' | 'missing' | 'invalid';

/**
 * Owns the canonical Project/entry snapshot load and its fail-closed state:
 * the mount-time load, explicit reloads, and the shared fallback that
 * downgrades to 'invalid'/'missing' when the structure cannot be read all
 * live here once. Mutations remain in the editor controller, which publishes
 * their results through `reload`/`adoptProject` instead of raw setters.
 */
/** Sessions whose leftover empty snapshot anchors were already swept in this page. */
const sweptSessions = new Set<string>();

/** Once per Project per page load, and never while a recording may still be filling it. */
async function sweepEmptySnapshotAnchors(sessionId: string): Promise<void> {
  if (sweptSessions.has(sessionId)) return;
  const recording = await getRecordingState().catch(() => null);
  if (!recording || (recording.isRecording && recording.sessionId === sessionId)) return;
  sweptSessions.add(sessionId);
  await repairEmptySnapshotAnchors(sessionId).catch((error) => {
    console.warn('[howbeam] failed to remove an empty snapshot anchor', error);
  });
}

export function useEditorProjectData(sessionId: string | null, steps: readonly unknown[]) {
  const [project, setProject] = useState<Project | null>(null);
  /** Set once the open Project's row is gone (deleted in another tab): the
   * editor keeps showing what it has, read-only, since nothing can be saved. */
  const [projectDeleted, setProjectDeleted] = useState(false);
  const [canonicalSnapshot, setCanonicalSnapshot] = useState<ProjectStructureSnapshot | null>(null);
  const [projectLoadState, setProjectLoadState] = useState<EditorProjectLoadState>(
    sessionId ? 'loading' : 'missing',
  );

  /** Publishes a freshly read canonical snapshot as the current editor data. */
  const adoptSnapshot = useCallback((snapshot: ProjectStructureSnapshot) => {
    setProject(snapshot.project);
    // Unchanged screenshots keep their Blob identity so reloading after an edit doesn't reload every image.
    setCanonicalSnapshot((current) => ({
      ...snapshot,
      entries: retainScreenshotBlobs(current?.entries ?? [], snapshot.entries),
    }));
    setProjectLoadState('ready');
  }, []);

  /** Publishes the fresh Project a successful compare-and-swap returned. The
   * entry list stays canonical until the caller's follow-up `reload`. */
  const adoptProject = useCallback((nextProject: Project | null) => {
    setProject(nextProject);
  }, []);

  /** Falls back after a failed structure read: keep the bare Project when it
   * still exists ('invalid') and report 'missing' otherwise. */
  const applyLoadFailure = useCallback(async (
    failedSessionId: string,
    isCancelled: () => boolean = () => false,
  ) => {
    const existingProject = await getProject(failedSessionId).catch(() => undefined);
    if (isCancelled()) return;
    setProject(existingProject ?? null);
    setCanonicalSnapshot(null);
    setProjectLoadState(existingProject ? 'invalid' : 'missing');
  }, []);

  const clear = useCallback(() => {
    setProject(null);
    setCanonicalSnapshot(null);
    setProjectLoadState('missing');
  }, []);

  /** Re-reads and adopts the canonical snapshot, returning it so callers that
   * need the fresh structure (e.g. publication) never re-implement the
   * read-then-adopt pair. Unlike the mount-time load it rethrows the
   * structure-read failure (after downgrading the state) so callers can
   * report the reload that went wrong. */
  const reload = useCallback(async (): Promise<ProjectStructureSnapshot | null> => {
    if (!sessionId) {
      clear();
      return null;
    }
    try {
      const snapshot = await getProjectStructureSnapshot(sessionId);
      adoptSnapshot(snapshot);
      return snapshot;
    } catch (reloadError) {
      await applyLoadFailure(sessionId);
      throw reloadError;
    }
  }, [adoptSnapshot, applyLoadFailure, clear, sessionId]);

  /** Re-reads the Project row after a write anywhere in the extension. A
   * missing row means it was deleted; otherwise metadata other tabs changed
   * (title, description, tags) is merged in. Structure and its revision stay
   * with the canonical snapshot, so a structural compare-and-swap is never
   * rebased onto entries this tab hasn't loaded. */
  const syncProjectRow = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    const stored = await getProject(sessionId);
    if (!stored) {
      setProjectDeleted(true);
      return;
    }
    setProject((current) => (
      current && current.id === stored.id && current.metadataRevision !== stored.metadataRevision
        ? { ...current, title: stored.title, description: stored.description, tags: stored.tags, metadataRevision: stored.metadataRevision }
        : current
    ));
  }, [sessionId]);

  useEffect(() => {
    setProjectDeleted(false);
    if (!sessionId) return;
    return subscribeProjectsChanged(() => {
      void syncProjectRow().catch((syncError) => {
        console.warn('[howbeam] failed to re-read the project after a change', syncError);
      });
    });
  }, [sessionId, syncProjectRow]);

  useEffect(() => {
    let disposed = false;
    if (!sessionId) {
      clear();
      return () => { disposed = true; };
    }
    setProjectLoadState((current) => current === 'ready' ? current : 'loading');
    void sweepEmptySnapshotAnchors(sessionId).then(() => getProjectStructureSnapshot(sessionId)).then((snapshot) => {
      if (disposed) return;
      adoptSnapshot(snapshot);
    }).catch(async (loadError) => {
      console.error('[howbeam] failed to read the project structure', loadError);
      if (disposed) return;
      await applyLoadFailure(sessionId, () => disposed);
    });
    return () => { disposed = true; };
  }, [adoptSnapshot, applyLoadFailure, clear, sessionId, steps]);

  return {
    project,
    canonicalSnapshot,
    projectLoadState,
    projectDeleted,
    syncProjectRow,
    reload,
    adoptProject,
  };
}
