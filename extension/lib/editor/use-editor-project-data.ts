import { useCallback, useEffect, useRef, useState } from 'react';
import { getProject } from '../storage/project-repository';
import { subscribeProjectsChanged } from '../storage/change-notifier';
import { ProjectNotFoundError } from '../storage/database';
import {
  getProjectStructureSnapshot,
  repairEmptySnapshotAnchors,
  type ProjectStructureMutationResult,
  type ProjectStructureSnapshot,
} from '../storage/project-structure';
import { getRecordingState } from '../storage/storage';
import { type Project } from '../storage/models';
import { retainScreenshotBlobs } from './retain-screenshot-blobs';

export type EditorProjectLoadState = 'loading' | 'ready' | 'missing' | 'invalid';

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

type ContentRevisions = Pick<Project, 'contentRevision' | 'stepEditRevision'>;

/**
 * Writes to a Project are serialized and each moves one of its revisions forward,
 * so of two reads of its structure the one with no lower revision is the newer.
 */
function notOlder(next: ContentRevisions, shown: ContentRevisions): boolean {
  return next.contentRevision >= shown.contentRevision && next.stepEditRevision >= shown.stepEditRevision;
}

function sameStructure(first: ContentRevisions, second: ContentRevisions): boolean {
  return first.contentRevision === second.contentRevision && first.stepEditRevision === second.stepEditRevision;
}

/** `next` with the title and description of whichever of the two has the newer metadata. */
function withNewestMetadata(next: Project, shown: Project | null): Project {
  if (!shown || next.metadataRevision >= shown.metadataRevision) return next;
  return { ...next, title: shown.title, description: shown.description, metadataRevision: shown.metadataRevision };
}

/**
 * The editor's one source of Project data. It is read when the Project opens and
 * again after every write anywhere in the extension (the change broadcast covers
 * this tab, other tabs and recordings alike) that moved this Project's revisions;
 * writes arriving while a read runs are folded into one more read. A write made
 * here hands over what it committed, so the screen shows it without waiting for
 * a read, and the read its broadcast sets off then finds nothing new.
 *
 * What is shown only ever moves forward in revision order, so a read that began
 * before a commit can never put the Project from before that commit back on screen.
 */
export function useEditorProjectData(sessionId: string | null) {
  const [project, setProject] = useState<Project | null>(null);
  /** Set once the open Project's row is gone (deleted in another tab): the
   * editor keeps showing what it has, read-only, since nothing can be saved. */
  const [projectDeleted, setProjectDeleted] = useState(false);
  const [canonicalSnapshot, setCanonicalSnapshot] = useState<ProjectStructureSnapshot | null>(null);
  const [projectLoadState, setProjectLoadState] = useState<EditorProjectLoadState>(
    sessionId ? 'loading' : 'missing',
  );
  /** The Project row behind what is on screen, read synchronously by the ordering rule. */
  const shown = useRef<Project | null>(null);
  const readInFlight = useRef(false);
  const readAgain = useRef(false);

  const showProject = useCallback((next: Project) => {
    shown.current = next;
    setProject(next);
  }, []);

  const show = useCallback((snapshot: ProjectStructureSnapshot) => {
    if (shown.current && !notOlder(snapshot.project, shown.current)) return;
    showProject(withNewestMetadata(snapshot.project, shown.current));
    // Unchanged screenshots keep their Blob identity so a new read doesn't reload every image.
    setCanonicalSnapshot((current) => ({
      ...snapshot,
      entries: retainScreenshotBlobs(current?.entries ?? [], snapshot.entries),
    }));
    setProjectLoadState('ready');
  }, [showProject]);

  /** A read failed. Once the Project has been shown it stays on screen: read-only
   * when its row is gone, unchanged otherwise (the next write reads it again).
   * Before that, the bare Project row decides between 'invalid' and 'missing'. */
  const applyLoadFailure = useCallback(async (failedSessionId: string, error: unknown) => {
    if (shown.current) {
      if (error instanceof ProjectNotFoundError) setProjectDeleted(true);
      return;
    }
    const existingProject = await getProject(failedSessionId).catch(() => undefined);
    setProject(existingProject ?? null);
    setCanonicalSnapshot(null);
    setProjectLoadState(existingProject ? 'invalid' : 'missing');
  }, []);

  /** Reads and shows the current structure, returning it. Rejects (after
   * applying the failure) so callers that need fresh data can report it. */
  const reload = useCallback(async (): Promise<ProjectStructureSnapshot | null> => {
    if (!sessionId) return null;
    try {
      const snapshot = await getProjectStructureSnapshot(sessionId);
      show(snapshot);
      return snapshot;
    } catch (error) {
      await applyLoadFailure(sessionId, error);
      throw error;
    }
  }, [applyLoadFailure, sessionId, show]);

  /** Shows the title and description a metadata write just committed.
   * Only the metadata is taken: the row's structure revisions may already count
   * a write from elsewhere whose structure this page hasn't read yet. */
  const adoptProject = useCallback((committed: Project) => {
    const current = shown.current;
    if (current) showProject(withNewestMetadata(current, committed));
  }, [showProject]);

  /** Reads the structure only when the Project row says it changed since what is shown;
   * a row whose only change is its title or description is taken as it is. */
  const reloadIfChanged = useCallback(async () => {
    if (!sessionId) return;
    if (shown.current) {
      const row = await getProject(sessionId);
      if (row && sameStructure(row, shown.current)) {
        adoptProject(row);
        return;
      }
    }
    await reload();
  }, [adoptProject, reload, sessionId]);

  /** Brings the screen up to date after a change; changes while a read runs fold into one more read. */
  const requestReload = useCallback(() => {
    if (readInFlight.current) {
      readAgain.current = true;
      return;
    }
    readInFlight.current = true;
    void (async () => {
      do {
        readAgain.current = false;
        await reloadIfChanged().catch((error) => console.error('[howbeam] failed to read the project structure', error));
      } while (readAgain.current);
      readInFlight.current = false;
    })();
  }, [reloadIfChanged]);

  /** Shows the structure a write made here just committed. */
  const adoptCommitted = useCallback((result: ProjectStructureMutationResult) => {
    show({ project: result.project, entries: result.entries, entryIds: result.entryIds });
  }, [show]);

  useEffect(() => {
    setProjectDeleted(false);
    if (!sessionId) {
      setProject(null);
      setCanonicalSnapshot(null);
      setProjectLoadState('missing');
      return undefined;
    }
    let disposed = false;
    setProjectLoadState((current) => (current === 'ready' ? current : 'loading'));
    void sweepEmptySnapshotAnchors(sessionId).then(() => {
      if (!disposed) requestReload();
    });
    const unsubscribe = subscribeProjectsChanged(requestReload);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [requestReload, sessionId]);

  return {
    project,
    canonicalSnapshot,
    projectLoadState,
    projectDeleted,
    reload,
    requestReload,
    adoptCommitted,
    adoptProject,
  };
}
