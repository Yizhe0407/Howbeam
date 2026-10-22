import type { IDBPTransaction } from 'idb';
import { repairProjectSections, type ProjectSection } from '../project/project-sections';
import {
  buildCompleteStepEntries,
  sanitizeProject,
  STEP_STORAGE_LIMITS,
  storageError,
  sanitizeStepForStorage,
  type Project,
  type ProjectSummary,
  type Step,
} from './models';
import {
  assertProjectStorageLimits,
  isPristineProject,
  ProjectNotFoundError,
  newProject,
  requireWritableProject,
  runProjectStepsWrite,
  runWithDatabase,
  summarizeSteps,
  type HowbeamDB,
  type ProjectStepsTransaction,
} from './database';
import { clearActiveProjectId } from './storage';
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
    const updated = sanitizeProject({ ...existing, ...patch, updatedAt: Math.max(existing.updatedAt, Date.now()), metadataRevision: existing.metadataRevision + 1 });
    await tx.store.put(updated);
    await tx.done;
    notifyProjectsChanged();
    return updated;
  });
}

/** Reads only denormalized project rows; no step cursor or screenshot Blob is opened. */
export async function getProjectSummaries(): Promise<ProjectSummary[]> {
  const projects = (await runWithDatabase((db) => db.getAllFromIndex('projects', 'by-updated-at')))
    .map(sanitizeProject);
  return projects.sort((first, second) => second.updatedAt - first.updatedAt);
}

interface PreparedProjectClone {
  project: Project;
  steps: Step[];
}

export interface CreateProjectFromStepsOptions {
  sections?: readonly ProjectSection[];
}

function prepareProjectClone(
  sourceSteps: readonly Step[],
  initial?: Partial<Pick<Project, 'title' | 'description'>>,
  options: CreateProjectFromStepsOptions = {},
): PreparedProjectClone {
  if (sourceSteps.length > STEP_STORAGE_LIMITS.maxStepsPerProject) {
    storageError('Project exceeds the maximum persisted step count.');
  }
  const now = Date.now();
  const projectId = crypto.randomUUID();
  const ids = new Map<string, string>();
  for (const step of sourceSteps) {
    if (ids.has(step.id)) throw new Error('Project contains duplicate step ids.');
    ids.set(step.id, crypto.randomUUID());
  }
  for (const step of sourceSteps) {
    if (step.groupId && !ids.has(step.groupId)) throw new Error('Project contains a broken snapshot reference.');
  }
  const sourceEntries = buildCompleteStepEntries(sourceSteps);
  const repairedSourceSections = repairProjectSections(options.sections ?? [], sourceEntries);
  const steps = [...sourceSteps]
    .sort((first, second) => first.order - second.order || first.id.localeCompare(second.id))
    .map((step, order) => sanitizeStepForStorage({
      ...step,
      id: ids.get(step.id)!,
      sessionId: projectId,
      runId: undefined,
      order,
      groupId: step.groupId ? ids.get(step.groupId) : undefined,
      lastCaptureRunId: undefined,
      timestamp: Number.isFinite(step.timestamp) ? step.timestamp : now,
    }));
  const sections = repairedSourceSections.map((section) => ({
    id: crypto.randomUUID(),
    title: section.title,
    startEntryId: ids.get(section.startEntryId)!,
  }));
  const summary = summarizeSteps(steps);
  assertProjectStorageLimits(summary);
  const project = newProject(projectId, now, initial, summary, steps.length > 0 ? 1 : 0);
  project.sections = sections;
  return { project, steps };
}

async function storePreparedProject(tx: ProjectStepsTransaction, prepared: PreparedProjectClone): Promise<void> {
  await tx.objectStore('projects').add(prepared.project);
  for (const step of prepared.steps) await tx.objectStore('steps').add(step);
}

export async function createProjectFromSteps(
  sourceSteps: readonly Step[],
  initial?: Partial<Pick<Project, 'title' | 'description'>>,
  options: CreateProjectFromStepsOptions = {},
): Promise<Project> {
  const prepared = prepareProjectClone(sourceSteps, initial, options);
  await assertStorableScreenshots(prepared.steps.map((step) => step.screenshotBlob));
  return runProjectStepsWrite(async (tx) => {
    await storePreparedProject(tx, prepared);
    return prepared.project;
  });
}

/** Reads the source snapshot and writes its clone in one serializable transaction. */
export async function duplicateProject(sourceId: string, title?: string): Promise<Project> {
  return runProjectStepsWrite(async (tx) => {
    const source = await tx.objectStore('projects').get(sourceId);
    if (!source) throw new ProjectNotFoundError(sourceId);
    const sourceSteps = await tx.objectStore('steps').index('by-session').getAll(sourceId);
    const sanitizedSource = sanitizeProject(source);
    const prepared = prepareProjectClone(sourceSteps, {
      title: title ?? t().common.duplicateTitle(sanitizedSource.title),
      description: sanitizedSource.description,
    }, { sections: sanitizedSource.sections });
    await storePreparedProject(tx, prepared);
    return prepared.project;
  });
}

/**
 * Reclaims a Project that was auto-created for a run which never produced
 * anything: deletes it and compare-and-clears the matching UI selection, but
 * only while it is still a pristine empty shell (see isPristineProject), so a
 * project the user has meanwhile named or filled is never destroyed. Callers
 * must only pass ids they themselves auto-created — an explicitly created
 * 專案庫 project shares the same empty shape and must never reach this.
 * Returns whether it deleted.
 */
export async function discardPristineProject(projectId: string): Promise<boolean> {
  const project = await getProject(projectId);
  if (!project || !isPristineProject(project)) return false;
  await deleteProjectPermanently(projectId);
  await clearActiveProjectId(projectId);
  return true;
}

export async function deleteProjectPermanently(id: string): Promise<void> {
  await runProjectStepsWrite(async (tx) => {
    let cursor = await tx.objectStore('steps').index('by-session').openCursor(id);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.objectStore('projects').delete(id);
  });
}

/** Atomically clears project content while preserving identity and metadata. */
export async function resetProject(id: string): Promise<Project> {
  return runProjectStepsWrite(async (tx) => {
    const project = await requireWritableProject(tx, id);
    let cursor = await tx.objectStore('steps').index('by-session').openCursor(id);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    const reset = sanitizeProject({
      ...project,
      updatedAt: Math.max(project.updatedAt, Date.now()),
      contentRevision: project.contentRevision + 1,
      sections: [],
      stepCount: 0,
      entryCount: 0,
      storageBytes: 0,
    });
    await tx.objectStore('projects').put(reset);
    return reset;
  });
}
