import type { IDBPTransaction } from 'idb';
import { repairProjectSections, type ProjectSection } from './project-sections';
import {
  buildCompleteStepEntries,
  getEntryImageOwner,
  sanitizeProject,
  STEP_STORAGE_LIMITS,
  storageError,
  type Project,
  type ProjectSummary,
  type Step,
  type StepEntry,
} from './models';
import {
  ProjectNotFoundError,
  newProject,
  requireProject,
  runProjectWrite,
  runWithDatabase,
  type HowbeamDB,
  type ProjectWriteTransaction,
} from './database';
import { commitEntries, readEntries } from './entry-store';
import { assertStorableScreenshots } from './screenshot-rules';
import { notifyProjectsChanged } from './change-notifier';
import { t } from '../shared/i18n';

export async function createProject(initial?: Partial<Pick<Project, 'title' | 'description'>>): Promise<Project> {
  const project = newProject(crypto.randomUUID(), Date.now(), initial);
  await runWithDatabase((db) => db.add('projects', project));
  notifyProjectsChanged();
  return project;
}

/** Explicit bootstrap primitive. Ordinary step mutations never call it. */
export async function ensureProject(id: string, createdAt = Date.now()): Promise<Project> {
  if (!id) throw new Error('Project id is required.');
  return runWithDatabase(async (db) => {
    const tx = db.transaction('projects', 'readwrite');
    const existing = await tx.store.get(id);
    if (existing) {
      await tx.done;
      return sanitizeProject(existing);
    }
    const project = newProject(id, createdAt);
    try {
      await tx.store.add(project);
      await tx.done;
      notifyProjectsChanged();
      return project;
    } catch (error) {
      await tx.done.catch(() => undefined);
      // A concurrent explicit bootstrap may have won the add race.
      const winner = await db.get('projects', id);
      if (winner) return sanitizeProject(winner);
      throw error;
    }
  });
}

export async function getProject(id: string): Promise<Project | undefined> {
  const project = await runWithDatabase((db) => db.get('projects', id));
  return project ? sanitizeProject(project) : undefined;
}

type ProjectOnlyTransaction = IDBPTransaction<HowbeamDB, ['projects'], 'readwrite'>;

/** Loads a project row inside a projects-only readwrite transaction, aborting the
 * transaction when the row is gone so the thrown error can never leave a
 * partial write behind. Returns the raw row; callers sanitize on write. */
async function requireProjectInTx(tx: ProjectOnlyTransaction, id: string): Promise<Project> {
  const existing = await tx.store.get(id);
  if (!existing) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new ProjectNotFoundError(id);
  }
  return existing;
}

/** A metadata edit. */
export interface ProjectMetadataChanges {
  title?: string;
  description?: string;
}

export async function updateProject(id: string, changes: ProjectMetadataChanges): Promise<Project> {
  return runWithDatabase(async (db) => {
    const tx = db.transaction('projects', 'readwrite');
    const existing = sanitizeProject(await requireProjectInTx(tx, id));
    const patch: Partial<Project> = {};
    if (changes.title !== undefined) patch.title = changes.title;
    if (changes.description !== undefined) patch.description = changes.description;
    const updated = sanitizeProject({
      ...existing,
      ...patch,
      updatedAt: Math.max(existing.updatedAt, Date.now()),
      metadataRevision: existing.metadataRevision + 1,
    });
    await tx.store.put(updated);
    await tx.done;
    notifyProjectsChanged();
    return updated;
  });
}

/** Reads only denormalized project rows; no step cursor or screenshot Blob is opened. */
export async function getProjectSummaries(): Promise<ProjectSummary[]> {
  const projects = (await runWithDatabase((db) => db.getAllFromIndex('projects', 'by-updated-at'))).map(
    sanitizeProject,
  );
  return projects.sort((first, second) => second.updatedAt - first.updatedAt);
}

export interface CreateProjectFromStepsOptions {
  sections?: readonly ProjectSection[];
}

interface PreparedProjectClone {
  project: Project;
  entries: StepEntry[];
}

/** Copies a timeline under fresh ids into a new Project, so a copy never
 * shares an id with its source. */
function prepareProjectClone(
  sourceEntries: readonly StepEntry[],
  initial?: Partial<Pick<Project, 'title' | 'description'>>,
  options: CreateProjectFromStepsOptions = {},
): PreparedProjectClone {
  const now = Date.now();
  const projectId = crypto.randomUUID();
  const ids = new Map<string, string>();
  const freshId = (id: string) => {
    if (ids.has(id)) throw new Error('Project contains duplicate step ids.');
    const fresh = crypto.randomUUID();
    ids.set(id, fresh);
    return fresh;
  };
  const copy = <T extends Step>(step: T, id: string, groupId?: string): T => ({
    ...step,
    id,
    sessionId: projectId,
    runId: undefined,
    groupId,
    lastCaptureRunId: undefined,
    timestamp: Number.isFinite(step.timestamp) ? step.timestamp : now,
  });
  const entries = sourceEntries.map((entry): StepEntry => {
    if (entry.kind === 'single') return { kind: 'single', step: copy(entry.step, freshId(entry.step.id)) };
    const anchorId = freshId(entry.anchor.id);
    return {
      kind: 'group',
      anchor: copy(entry.anchor, anchorId, anchorId),
      annotations: entry.annotations.map((annotation) => copy(annotation, freshId(annotation.id), anchorId)),
    };
  });
  const project = newProject(projectId, now, initial);
  project.sections = repairProjectSections(options.sections ?? [], sourceEntries).map((section) => ({
    id: crypto.randomUUID(),
    title: section.title,
    startEntryId: ids.get(section.startEntryId)!,
  }));
  return { project, entries };
}

/** Adds the Project and then its timeline, so the summary is the one every write computes. */
async function storePreparedProject(tx: ProjectWriteTransaction, prepared: PreparedProjectClone): Promise<Project> {
  await tx.objectStore('projects').add(prepared.project);
  if (prepared.entries.length === 0) return prepared.project;
  return (await commitEntries(tx, prepared.project, [], prepared.entries, { timestamp: prepared.project.updatedAt }))
    .project;
}

export async function createProjectFromSteps(
  sourceSteps: readonly Step[],
  initial?: Partial<Pick<Project, 'title' | 'description'>>,
  options: CreateProjectFromStepsOptions = {},
): Promise<Project> {
  if (sourceSteps.length > STEP_STORAGE_LIMITS.maxStepsPerProject) {
    storageError('Project exceeds the maximum persisted step count.');
  }
  const prepared = prepareProjectClone(buildCompleteStepEntries(sourceSteps), initial, options);
  await assertStorableScreenshots(prepared.entries.map((entry) => getEntryImageOwner(entry).screenshotBlob));
  return runProjectWrite((tx) => storePreparedProject(tx, prepared));
}

/** Reads the source snapshot and writes its clone in one serializable transaction. */
export async function duplicateProject(sourceId: string, title?: string): Promise<Project> {
  return runProjectWrite(async (tx) => {
    const source = await requireProject(tx, sourceId);
    const prepared = prepareProjectClone(
      await readEntries(tx, sourceId),
      {
        title: title ?? t().common.duplicateTitle(source.title),
        description: source.description,
      },
      { sections: source.sections },
    );
    return storePreparedProject(tx, prepared);
  });
}

async function deleteProjectContents(tx: ProjectWriteTransaction, id: string): Promise<void> {
  for (const entryKey of await tx.objectStore('entries').index('by-project').getAllKeys(id)) {
    await tx.objectStore('entries').delete(entryKey);
    await tx.objectStore('screenshots').delete(entryKey);
  }
  for (const pendingKey of await tx.objectStore('pendingAnchors').index('by-project').getAllKeys(id)) {
    await tx.objectStore('pendingAnchors').delete(pendingKey);
  }
  await tx.objectStore('projects').delete(id);
}

export async function deleteProjectPermanently(id: string): Promise<void> {
  await runProjectWrite((tx) => deleteProjectContents(tx, id));
}
