import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import { notifyProjectsChanged } from './change-notifier';
import {
  STEP_STORAGE_LIMITS,
  requireStorageIdentifier,
  sanitizeProject,
  storageError,
  type Project,
  type Step,
} from './models';

/**
 * One timeline entry per record: an ordinary step, or a snapshot with its
 * annotations in order. The screenshot is kept in `screenshots` under the same
 * id, so reading the timeline's structure never loads image bytes.
 */
export interface StoredEntry {
  id: string;
  projectId: string;
  order: number;
  kind: 'single' | 'group';
  /** The image owner without its Blob: the step itself, or the snapshot's base image. */
  owner: Step;
  /** Empty for an ordinary step; a stored snapshot always has at least one. */
  annotations: Step[];
  /** Every step id the entry holds, for finding the entry of an annotation. */
  memberIds: string[];
  screenshotBytes: number;
}

export interface StoredScreenshot {
  id: string;
  blob: Blob;
}

/** A snapshot's base image before its first annotation. It is not part of its
 * Project yet: it becomes an entry together with that annotation. */
export interface PendingAnchor {
  id: string;
  projectId: string;
  step: Step;
}

export interface HowbeamDB extends DBSchema {
  projects: {
    key: string;
    value: Project;
    indexes: { 'by-updated-at': number };
  };
  entries: {
    key: string;
    value: StoredEntry;
    indexes: { 'by-project': string; 'by-member': string };
  };
  screenshots: {
    key: string;
    value: StoredScreenshot;
  };
  pendingAnchors: {
    key: string;
    value: PendingAnchor;
    indexes: { 'by-project': string };
  };
  /** Device-local state, keyed by name: the backup folder and its last run, the recording's undo window. */
  deviceState: {
    key: string;
    value: unknown;
  };
  /** What the backup folder holds for each Project. */
  backupManifest: {
    key: string;
    value: unknown;
  };
}

type ProjectStores = ['projects', 'entries', 'screenshots', 'pendingAnchors'];
export type ProjectWriteTransaction = IDBPTransaction<HowbeamDB, ProjectStores, 'readwrite'>;
export type ProjectReadTransaction = IDBPTransaction<HowbeamDB, ProjectStores, 'readonly'>;
export type ProjectTransaction = ProjectWriteTransaction | ProjectReadTransaction;

export type ProjectSummaryFields = Pick<Project, 'stepCount' | 'entryCount' | 'storageBytes'>;

export function assertProjectStorageLimits(
  summary: Pick<Project, 'stepCount' | 'storageBytes'>,
  baseline?: Pick<Project, 'stepCount' | 'storageBytes'>,
): void {
  if (
    summary.stepCount > STEP_STORAGE_LIMITS.maxStepsPerProject &&
    (!baseline || summary.stepCount > baseline.stepCount)
  ) {
    storageError('Project exceeds the maximum persisted step count.');
  }
  if (
    summary.storageBytes > STEP_STORAGE_LIMITS.maxTotalScreenshotBytes &&
    (!baseline || summary.storageBytes > baseline.storageBytes)
  ) {
    storageError('Project exceeds the total screenshot storage limit.');
  }
}

export function newProject(
  id: string,
  now: number,
  initial?: Partial<Pick<Project, 'title' | 'description'>>,
  summary: ProjectSummaryFields = { stepCount: 0, entryCount: 0, storageBytes: 0 },
  contentRevision = 0,
): Project {
  return sanitizeProject({
    id: requireStorageIdentifier(id, 'Project id'),
    title: initial?.title ?? '',
    description: initial?.description ?? '',
    sections: [],
    createdAt: now,
    updatedAt: now,
    contentRevision,
    stepEditRevision: 0,
    metadataRevision: 0,
    ...summary,
  });
}

/** The Project row is gone (usually deleted from the Library in another tab).
 * Typed so an editor can tell "deleted" apart from an ordinary write failure. */
export class ProjectNotFoundError extends Error {
  constructor(public readonly projectId: string) {
    super('Project not found.');
    this.name = 'ProjectNotFoundError';
  }
}

export async function requireProject(tx: ProjectTransaction, id: string): Promise<Project> {
  const project = await tx.objectStore('projects').get(id);
  if (!project) throw new ProjectNotFoundError(id);
  return sanitizeProject(project);
}

/** After a step was edited in place. Such an edit never touches what the
 * summary counts (entries, steps, screenshots), so nothing is recomputed. */
export async function recordStepEdit(tx: ProjectWriteTransaction, project: Project): Promise<void> {
  await tx.objectStore('projects').put(
    sanitizeProject({
      ...project,
      updatedAt: Math.max(project.updatedAt, Date.now()),
      stepEditRevision: project.stepEditRevision + 1,
    }),
  );
}

async function abortTransaction(tx: ProjectWriteTransaction, error: unknown): Promise<never> {
  try {
    tx.abort();
  } catch {
    // The transaction may already have been aborted by IndexedDB.
  }
  await tx.done.catch(() => undefined);
  throw error;
}

/** Howbeam has not shipped, so no older layout is migrated: opening a database
 * from an earlier version drops its stores and starts empty. */
export const DATABASE_VERSION = 4;

let databasePromise: Promise<IDBPDatabase<HowbeamDB>> | undefined;
let databaseConnection: IDBPDatabase<HowbeamDB> | undefined;

function getDatabase(): Promise<IDBPDatabase<HowbeamDB>> {
  if (databasePromise) return databasePromise;
  databasePromise = openDB<HowbeamDB>('howbeam', DATABASE_VERSION, {
    upgrade(db) {
      for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
      const projects = db.createObjectStore('projects', { keyPath: 'id' });
      projects.createIndex('by-updated-at', 'updatedAt');
      const entries = db.createObjectStore('entries', { keyPath: 'id' });
      entries.createIndex('by-project', 'projectId');
      entries.createIndex('by-member', 'memberIds', { unique: true, multiEntry: true });
      db.createObjectStore('screenshots', { keyPath: 'id' });
      const pending = db.createObjectStore('pendingAnchors', { keyPath: 'id' });
      pending.createIndex('by-project', 'projectId');
      db.createObjectStore('deviceState');
      db.createObjectStore('backupManifest');
    },
    blocked(currentVersion, blockedVersion) {
      console.warn(
        `Howbeam database upgrade to ${blockedVersion ?? 'unknown'} is blocked by version ${currentVersion}.`,
      );
    },
    blocking(currentVersion, blockedVersion) {
      // A versionchange must never remain blocked by this long-lived extension
      // context. Closing here lets the newer worker/page finish its upgrade.
      databaseConnection?.close();
      databaseConnection = undefined;
      databasePromise = undefined;
      console.warn(`Howbeam database version ${currentVersion} closed for version ${blockedVersion ?? 'unknown'}.`);
    },
    terminated() {
      databaseConnection = undefined;
      databasePromise = undefined;
    },
  })
    .then((db) => {
      databaseConnection = db;
      return db;
    })
    .catch((error) => {
      databasePromise = undefined;
      throw error;
    });
  return databasePromise;
}

function isClosedConnectionError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'InvalidStateError';
}

/** Runs one repository operation against the shared connection. The `blocking`
 * handler above (and browser `terminated`) may close that connection while a
 * caller still holds the awaited db, making its next transaction()/request
 * throw InvalidStateError before any work commits. Because nothing was
 * committed, retrying once against a freshly opened connection is safe and
 * transparently recovers autosaves and other in-flight callers. */
export async function runWithDatabase<T>(operation: (db: IDBPDatabase<HowbeamDB>) => Promise<T>): Promise<T> {
  const db = await getDatabase();
  try {
    return await operation(db);
  } catch (error) {
    if (!isClosedConnectionError(error)) throw error;
    const reopened = await getDatabase();
    // Same connection means it was never closed; the error has another cause.
    if (reopened === db) throw error;
    return operation(reopened);
  }
}

/** One readwrite transaction over a Project and everything it holds: one
 * commit, closed-connection retry, and rollback through abortTransaction so a
 * failing body never leaves a partial write behind. */
export async function runProjectWrite<T>(
  operation: (tx: ProjectWriteTransaction) => Promise<T>,
  { notify = true }: { notify?: boolean } = {},
): Promise<T> {
  return runWithDatabase(async (db) => {
    const tx = db.transaction(['projects', 'entries', 'screenshots', 'pendingAnchors'], 'readwrite');
    try {
      const result = await operation(tx);
      await tx.done;
      if (notify) notifyProjectsChanged();
      return result;
    } catch (error) {
      return abortTransaction(tx, error);
    }
  });
}

export async function runProjectRead<T>(operation: (tx: ProjectReadTransaction) => Promise<T>): Promise<T> {
  return runWithDatabase(async (db) => {
    const tx = db.transaction(['projects', 'entries', 'screenshots', 'pendingAnchors'], 'readonly');
    const result = await operation(tx);
    await tx.done;
    return result;
  });
}

/** Closes the shared connection. Primarily useful for tests and graceful teardown. */
export async function closeDatabase(): Promise<void> {
  const pending = databasePromise;
  databasePromise = undefined;
  const db = databaseConnection ?? (pending ? await pending.catch(() => undefined) : undefined);
  databaseConnection = undefined;
  db?.close();
}
