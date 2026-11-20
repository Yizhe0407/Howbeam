import type { IDBPObjectStore, IDBPTransaction, StoreNames } from 'idb';
import { ProjectNotFoundError, runDatabaseWrite, runWithDatabase, type HowbeamDB } from './database';
import { notifySeriesChanged } from './change-notifier';
import { requireStorageIdentifier, storageError } from './models';
import { SERIES_LIMITS, sanitizeSeries, sanitizeSeriesTitle, type ProjectSeries } from './series-model';

type SeriesTransaction = IDBPTransaction<HowbeamDB, ['series', 'projects'], 'readwrite'>;
type WritableSeriesStore = IDBPObjectStore<HowbeamDB, ArrayLike<StoreNames<HowbeamDB>>, 'series', 'readwrite'>;

export class SeriesNotFoundError extends Error {
  constructor(public readonly seriesId: string) {
    super('Series not found.');
    this.name = 'SeriesNotFoundError';
  }
}

function runSeriesWrite<T>(operation: (tx: SeriesTransaction) => Promise<T>): Promise<T> {
  return runDatabaseWrite(['series', 'projects'], operation, notifySeriesChanged);
}

async function requireSeries(tx: SeriesTransaction, id: string): Promise<ProjectSeries> {
  const stored = await tx.objectStore('series').get(id);
  if (!stored) throw new SeriesNotFoundError(id);
  return sanitizeSeries(stored);
}

async function requireProject(tx: SeriesTransaction, id: string): Promise<void> {
  requireStorageIdentifier(id, 'projectId');
  if (!(await tx.objectStore('projects').getKey(id))) throw new ProjectNotFoundError(id);
}

/**
 * Takes `projectIds` out of every Series other than `keepSeriesId`, keeping a
 * Project in at most one Series. Returns whether any Series changed.
 */
export async function detachProjectsFromSeries(
  store: WritableSeriesStore,
  projectIds: ReadonlySet<string>,
  keepSeriesId?: string,
): Promise<boolean> {
  let changed = false;
  for (const stored of await store.getAll()) {
    if (stored.id === keepSeriesId) continue;
    const series = sanitizeSeries(stored);
    const kept = series.projectIds.filter((id) => !projectIds.has(id));
    if (kept.length === series.projectIds.length) continue;
    await store.put({ ...series, projectIds: kept, updatedAt: Math.max(series.updatedAt, Date.now()) });
    changed = true;
  }
  return changed;
}

function withProjects(series: ProjectSeries, projectIds: string[]): ProjectSeries {
  if (projectIds.length > SERIES_LIMITS.maxProjects) storageError('Series exceeds the maximum project count.');
  return { ...series, projectIds, updatedAt: Math.max(series.updatedAt, Date.now()) };
}

export async function getAllSeries(): Promise<ProjectSeries[]> {
  const rows = await runWithDatabase((db) => db.getAll('series'));
  return rows.map(sanitizeSeries);
}

/** A new Series row; the caller stores it in the same write that makes its Projects members. */
export function newSeries(title: string, projectIds: readonly string[]): ProjectSeries {
  const now = Date.now();
  return withProjects(
    { id: crypto.randomUUID(), title: sanitizeSeriesTitle(title), projectIds: [], createdAt: now, updatedAt: now },
    [...new Set(projectIds)],
  );
}

/** Creates a Series holding `projectIds` in that order, moving each out of any Series it was in. */
export async function createSeries(title = '', projectIds: readonly string[] = []): Promise<ProjectSeries> {
  return runSeriesWrite(async (tx) => {
    const series = newSeries(title, projectIds);
    for (const id of series.projectIds) await requireProject(tx, id);
    const store = tx.objectStore('series');
    await detachProjectsFromSeries(store, new Set(series.projectIds));
    await store.add(series);
    return series;
  });
}

export async function renameSeries(id: string, title: string): Promise<ProjectSeries> {
  return runSeriesWrite(async (tx) => {
    const series = await requireSeries(tx, id);
    const updated = { ...series, title: sanitizeSeriesTitle(title), updatedAt: Math.max(series.updatedAt, Date.now()) };
    await tx.objectStore('series').put(updated);
    return updated;
  });
}

/** Removes the Series only; its Projects stay in the Library. */
export async function deleteSeries(id: string): Promise<void> {
  await runSeriesWrite(async (tx) => {
    await requireSeries(tx, id);
    await tx.objectStore('series').delete(id);
  });
}

/** Appends the Project to the Series, moving it out of the Series it was in. A member stays where it is. */
export async function addProjectToSeries(seriesId: string, projectId: string): Promise<ProjectSeries> {
  return runSeriesWrite(async (tx) => {
    const series = await requireSeries(tx, seriesId);
    await requireProject(tx, projectId);
    if (series.projectIds.includes(projectId)) return series;
    const store = tx.objectStore('series');
    await detachProjectsFromSeries(store, new Set([projectId]), seriesId);
    const updated = withProjects(series, [...series.projectIds, projectId]);
    await store.put(updated);
    return updated;
  });
}

export async function removeProjectFromSeries(seriesId: string, projectId: string): Promise<ProjectSeries> {
  return runSeriesWrite(async (tx) => {
    const series = await requireSeries(tx, seriesId);
    if (!series.projectIds.includes(projectId)) return series;
    const updated = withProjects(series, series.projectIds.filter((id) => id !== projectId));
    await tx.objectStore('series').put(updated);
    return updated;
  });
}

/** `projectIds` must hold exactly the Series' current members, in their new order. */
export async function reorderSeries(seriesId: string, projectIds: readonly string[]): Promise<ProjectSeries> {
  return runSeriesWrite(async (tx) => {
    const series = await requireSeries(tx, seriesId);
    const current = new Set(series.projectIds);
    const next = [...new Set(projectIds)];
    if (next.length !== projectIds.length || next.length !== current.size || next.some((id) => !current.has(id))) {
      storageError('Series order must list exactly its current projects.');
    }
    const updated = withProjects(series, next);
    await tx.objectStore('series').put(updated);
    return updated;
  });
}
