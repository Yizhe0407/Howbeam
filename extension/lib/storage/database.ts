import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import { notifyProjectsChanged } from './change-notifier';
import {
  STEP_STORAGE_LIMITS,
  getEffectiveBounds,
  requireStorageIdentifier,
  sanitizeProject,
  stepRole,
  storageError,
  type Project,
  type Step,
} from './models';

export interface HowbeamDB extends DBSchema {
  steps: {
    key: string;
    value: Step;
    indexes: { 'by-session': string };
  };
  projects: {
    key: string;
    value: Project;
    indexes: { 'by-updated-at': number };
  };
}

export type ProjectStepsTransaction = IDBPTransaction<HowbeamDB, ['projects', 'steps'], 'readwrite'>;
export type ReadonlyProjectStepsTransaction = IDBPTransaction<HowbeamDB, ['projects', 'steps'], 'readonly'>;

interface GroupSummaryAccumulator {
  hasAnchorImage: boolean;
  validAnnotationCount: number;
  fallbackImageCount: number;
}

interface SummaryAccumulator {
  stepCount: number;
  ordinaryEntryCount: number;
  storageBytes: number;
  groups: Map<string, GroupSummaryAccumulator>;
}

function createSummaryAccumulator(): SummaryAccumulator {
  return { stepCount: 0, ordinaryEntryCount: 0, storageBytes: 0, groups: new Map() };
}

function addStepToSummary(summary: SummaryAccumulator, step: Step): void {
  const role = stepRole(step);
  // Anchors are shared base images, not user-visible steps.
  if (role !== 'anchor') summary.stepCount += 1;
  summary.storageBytes = Math.min(
    Number.MAX_SAFE_INTEGER,
    summary.storageBytes + (step.screenshotBlob?.size ?? 0),
  );

  if (role === 'ordinary') {
    if (step.screenshotBlob) summary.ordinaryEntryCount += 1;
    return;
  }

  const groupId = step.groupId!; // anchors and annotations always carry one
  let group = summary.groups.get(groupId);
  if (!group) {
    group = { hasAnchorImage: false, validAnnotationCount: 0, fallbackImageCount: 0 };
    summary.groups.set(groupId, group);
  }
  if (role === 'anchor' && step.screenshotBlob) group.hasAnchorImage = true;
  if (role === 'annotation' && getEffectiveBounds(step)) group.validAnnotationCount += 1;
  if (step.screenshotBlob) group.fallbackImageCount += 1;
}

function finishSummary(summary: SummaryAccumulator): Pick<Project, 'stepCount' | 'entryCount' | 'storageBytes'> {
  let entryCount = summary.ordinaryEntryCount;
  for (const group of summary.groups.values()) {
    entryCount += group.hasAnchorImage
      ? Number(group.validAnnotationCount > 0)
      : group.fallbackImageCount;
  }
  return {
    stepCount: summary.stepCount,
    entryCount,
    storageBytes: summary.storageBytes,
  };
}

export function summarizeSteps(steps: Iterable<Step>): Pick<Project, 'stepCount' | 'entryCount' | 'storageBytes'> {
  const summary = createSummaryAccumulator();
  for (const step of steps) addStepToSummary(summary, step);
  return finishSummary(summary);
}

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
  summary: Pick<Project, 'stepCount' | 'entryCount' | 'storageBytes'> = {
    stepCount: 0,
    entryCount: 0,
    storageBytes: 0,
  },
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

/**
 * True while a (sanitized) Project is still exactly the empty shell newProject
 * leaves behind with no initial metadata: nothing recorded, and no
 * user-entered title, description, or sections. An unnamed project's title
 * is empty (see sanitizeProject). contentRevision is
 * deliberately not consulted: transient rows such as a snapshot run's deleted
 * empty anchor bump it without leaving any user content behind.
 */
export function isPristineProject(project: Project): boolean {
  return (
    project.stepCount === 0 &&
    project.entryCount === 0 &&
    project.title === '' &&
    project.description === '' &&
    project.sections.length === 0
  );
}

/** The Project row is gone (usually deleted from the Library in another tab).
 * Typed so an editor can tell "deleted" apart from an ordinary write failure. */
export class ProjectNotFoundError extends Error {
  constructor(public readonly projectId: string) {
    super('Project not found.');
    this.name = 'ProjectNotFoundError';
  }
}

export async function requireWritableProject(tx: ProjectStepsTransaction, id: string): Promise<Project> {
  const project = await tx.objectStore('projects').get(id);
  if (!project) throw new ProjectNotFoundError(id);
  return sanitizeProject(project);
}

/** After rows were added, removed or moved: recomputes the summary and moves
 * the structure revision. */
export async function refreshProjectSummary(
  tx: ProjectStepsTransaction,
  project: Project,
  timestamp = Date.now(),
): Promise<Project> {
  const summary = createSummaryAccumulator();
  let cursor = await tx.objectStore('steps').index('by-session').openCursor(project.id);
  while (cursor) {
    addStepToSummary(summary, cursor.value);
    cursor = await cursor.continue();
  }
  return writeProjectSummary(tx, project, finishSummary(summary), timestamp);
}

/** refreshProjectSummary for a write that already read the Project's rows:
 * `rows` must be every row the Project holds once this transaction's writes
 * land, so the rows are not walked a second time. */
export async function refreshProjectSummaryFromRows(
  tx: ProjectStepsTransaction,
  project: Project,
  rows: Iterable<Step>,
  timestamp = Date.now(),
): Promise<Project> {
  return writeProjectSummary(tx, project, summarizeSteps(rows), timestamp);
}

async function writeProjectSummary(
  tx: ProjectStepsTransaction,
  project: Project,
  finishedSummary: Pick<Project, 'stepCount' | 'entryCount' | 'storageBytes'>,
  timestamp: number,
): Promise<Project> {
  assertProjectStorageLimits(finishedSummary, project);
  const updated = sanitizeProject({
    ...project,
    ...finishedSummary,
    updatedAt: Math.max(project.updatedAt, timestamp, Date.now()),
    contentRevision: project.contentRevision + 1,
  });
  await tx.objectStore('projects').put(updated);
  return updated;
}

/** After a row was edited in place. Such an edit never touches what the
 * summary counts (roles, screenshots, bounds), so nothing is recomputed. */
export async function recordStepEdit(tx: ProjectStepsTransaction, project: Project): Promise<void> {
  await tx.objectStore('projects').put(sanitizeProject({
    ...project,
    updatedAt: Math.max(project.updatedAt, Date.now()),
    stepEditRevision: project.stepEditRevision + 1,
  }));
}

async function abortTransaction(tx: ProjectStepsTransaction, error: unknown): Promise<never> {
  try {
    tx.abort();
  } catch {
    // The transaction may already have been aborted by IndexedDB.
  }
  await tx.done.catch(() => undefined);
  throw error;
}

// Older databases are not upgraded. It stays 2 because lowering it would stop browsers that already hold version 2 from opening.
export const DATABASE_VERSION = 2;

let databasePromise: Promise<IDBPDatabase<HowbeamDB>> | undefined;
let databaseConnection: IDBPDatabase<HowbeamDB> | undefined;

function getDatabase(): Promise<IDBPDatabase<HowbeamDB>> {
  if (databasePromise) return databasePromise;
  databasePromise = openDB<HowbeamDB>('howbeam', DATABASE_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion >= 1) return;
      const steps = db.createObjectStore('steps', { keyPath: 'id' });
      steps.createIndex('by-session', 'sessionId');
      const projects = db.createObjectStore('projects', { keyPath: 'id' });
      projects.createIndex('by-updated-at', 'updatedAt');
    },
    blocked(currentVersion, blockedVersion) {
      console.warn(`Howbeam database upgrade to ${blockedVersion ?? 'unknown'} is blocked by version ${currentVersion}.`);
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
  }).then((db) => {
    databaseConnection = db;
    return db;
  }).catch((error) => {
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
export async function runWithDatabase<T>(
  operation: (db: IDBPDatabase<HowbeamDB>) => Promise<T>,
): Promise<T> {
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

/** Standard projects+steps readwrite transaction: closed-connection retry, one
 * commit, and rollback through abortTransaction so a failing body can never
 * leak an unhandled tx.done rejection. */
export async function runProjectStepsWrite<T>(
  operation: (tx: ProjectStepsTransaction) => Promise<T>,
): Promise<T> {
  return runWithDatabase(async (db) => {
    const tx = db.transaction(['projects', 'steps'], 'readwrite');
    try {
      const result = await operation(tx);
      await tx.done;
      notifyProjectsChanged();
      return result;
    } catch (error) {
      return abortTransaction(tx, error);
    }
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


function sortSessionSteps(sessionSteps: Step[], orderedIds: string[]): Step[] {
  const byId = new Map(sessionSteps.map((step) => [step.id, step]));
  const seen = new Set<string>();
  const reordered: Step[] = [];

  for (const id of orderedIds) {
    const step = byId.get(id);
    if (step && !seen.has(id)) {
      reordered.push(step);
      seen.add(id);
    }
  }
  for (const step of [...sessionSteps].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
    if (!seen.has(step.id)) reordered.push(step);
  }
  return reordered;
}

export async function writeDenseOrder(tx: ProjectStepsTransaction, steps: Step[], orderedIds: string[]): Promise<void> {
  const reordered = sortSessionSteps(steps, orderedIds);
  for (const [order, step] of reordered.entries()) {
    if (step.order !== order) await tx.objectStore('steps').put({ ...step, order });
  }
}
