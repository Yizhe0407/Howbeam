import { repairProjectSections, type ProjectSection } from '../project/project-sections';
import {
  entryId,
  getEffectiveBounds,
  ProjectStructureIntegrityError,
  sanitizeProject,
  sanitizeStepForStorage,
  type Project,
  type ScreenshotStep,
  type Step,
  type StepEntry,
} from './models';
import {
  assertProjectStorageLimits,
  type ProjectSummaryFields,
  type ProjectTransaction,
  type ProjectWriteTransaction,
  type StoredEntry,
} from './database';

/** What the Project row keeps about its entries, computed from the entries themselves. */
export function summarizeEntries(entries: readonly StepEntry[]): ProjectSummaryFields {
  let stepCount = 0;
  let storageBytes = 0;
  for (const entry of entries) {
    stepCount += entry.kind === 'single' ? 1 : entry.annotations.length;
    storageBytes = Math.min(Number.MAX_SAFE_INTEGER, storageBytes + ownerOf(entry).screenshotBlob.size);
  }
  return { stepCount, entryCount: entries.length, storageBytes };
}

function ownerOf(entry: StepEntry): ScreenshotStep {
  return entry.kind === 'single' ? entry.step : entry.anchor;
}

function withoutBlob({ screenshotBlob: _blob, ...step }: Step): Step {
  return step;
}

/**
 * Checks that every entry is whole and belongs to the Project, and returns the
 * entries with their steps sanitized for storage and numbered densely in
 * timeline order (a snapshot's base image takes a number before its
 * annotations, as the steps of a flattened timeline).
 */
export function normalizeEntries(entries: readonly StepEntry[], projectId: string, firstOrder = 0): StepEntry[] {
  const seen = new Set<string>();
  let order = firstOrder;
  const claim = (step: Step): Step => {
    if (seen.has(step.id)) throw new ProjectStructureIntegrityError('Project contains duplicate step ids.');
    seen.add(step.id);
    if (step.sessionId !== projectId) {
      throw new ProjectStructureIntegrityError('Project contains a row from another session.');
    }
    const stored = sanitizeStepForStorage(step.order === order ? step : { ...step, order });
    order += 1;
    return stored;
  };
  return entries.map((entry): StepEntry => {
    if (entry.kind === 'single') {
      if (entry.step.groupId !== undefined || !(entry.step.screenshotBlob instanceof Blob)) {
        throw new ProjectStructureIntegrityError('An ordinary entry is missing its screenshot.');
      }
      return { kind: 'single', step: claim(entry.step) as ScreenshotStep };
    }
    const { anchor, annotations } = entry;
    if (anchor.groupId !== anchor.id || !(anchor.screenshotBlob instanceof Blob)) {
      throw new ProjectStructureIntegrityError('A snapshot group is missing its leading image anchor.');
    }
    if (annotations.length === 0) {
      throw new ProjectStructureIntegrityError('A snapshot group has no complete annotation.');
    }
    const storedAnchor = claim(anchor) as ScreenshotStep;
    return {
      kind: 'group',
      anchor: storedAnchor,
      annotations: annotations.map((annotation) => {
        if (annotation.groupId !== anchor.id || annotation.id === anchor.id || !getEffectiveBounds(annotation)) {
          throw new ProjectStructureIntegrityError('A snapshot group contains an invalid annotation.');
        }
        return claim(annotation);
      }),
    };
  });
}

function toRecord(entry: StepEntry, projectId: string, order: number): StoredEntry {
  const owner = ownerOf(entry);
  const annotations = entry.kind === 'group' ? entry.annotations.map(withoutBlob) : [];
  return {
    id: owner.id,
    projectId,
    order,
    kind: entry.kind,
    owner: withoutBlob(owner),
    annotations,
    memberIds: [owner.id, ...annotations.map((annotation) => annotation.id)],
    screenshotBytes: owner.screenshotBlob.size,
  };
}

/** The entry a record describes, with its screenshot put back on its image owner. */
export function hydrateEntry(record: StoredEntry, blob: Blob): StepEntry {
  const owner = { ...record.owner, screenshotBlob: blob } as ScreenshotStep;
  return record.kind === 'single'
    ? { kind: 'single', step: owner }
    : { kind: 'group', anchor: owner, annotations: record.annotations.map((annotation) => ({ ...annotation })) };
}

export async function readEntryRecords(tx: ProjectTransaction, projectId: string): Promise<StoredEntry[]> {
  const records = await tx.objectStore('entries').index('by-project').getAll(projectId);
  return records.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

async function requireScreenshot(tx: ProjectTransaction, id: string): Promise<Blob> {
  const screenshot = await tx.objectStore('screenshots').get(id);
  if (!screenshot) throw new ProjectStructureIntegrityError('An entry is missing its screenshot.');
  return screenshot.blob;
}

/** The Project's timeline, with screenshots, in order. */
export async function readEntries(tx: ProjectTransaction, projectId: string): Promise<StepEntry[]> {
  const records = await readEntryRecords(tx, projectId);
  const entries: StepEntry[] = [];
  for (const record of records) entries.push(hydrateEntry(record, await requireScreenshot(tx, record.id)));
  return entries;
}

export async function readEntry(tx: ProjectTransaction, record: StoredEntry): Promise<StepEntry> {
  return hydrateEntry(record, await requireScreenshot(tx, record.id));
}

/** The record holding a step id: an ordinary step, a snapshot's base image or one of its annotations. */
export async function findEntryRecord(tx: ProjectTransaction, stepId: string): Promise<StoredEntry | undefined> {
  return tx.objectStore('entries').index('by-member').get(stepId);
}

export interface CommitEntriesOptions {
  /** Defaults to the Project's current sections; either way they are repaired against the new timeline. */
  sections?: readonly ProjectSection[];
  timestamp?: number;
}

export interface CommittedEntries {
  project: Project;
  entries: StepEntry[];
}

/**
 * Writes the Project's whole timeline as `next`, given the timeline it had
 * (`previous`, as read in this transaction), and moves the Project's summary
 * and structure revision with it. Screenshots are rewritten only when an
 * entry's image changed.
 */
export async function commitEntries(
  tx: ProjectWriteTransaction,
  project: Project,
  previous: readonly StepEntry[],
  next: readonly StepEntry[],
  { sections = project.sections, timestamp = Date.now() }: CommitEntriesOptions = {},
): Promise<CommittedEntries> {
  const entries = normalizeEntries(next, project.id);
  const summary = summarizeEntries(entries);
  assertProjectStorageLimits(summary, project);

  const previousBlobs = new Map(previous.map((entry) => [entryId(entry), ownerOf(entry).screenshotBlob]));
  const nextIds = new Set(entries.map(entryId));
  for (const id of previousBlobs.keys()) {
    if (nextIds.has(id)) continue;
    await tx.objectStore('entries').delete(id);
    await tx.objectStore('screenshots').delete(id);
  }
  for (const [order, entry] of entries.entries()) {
    const id = entryId(entry);
    const blob = ownerOf(entry).screenshotBlob;
    const record = toRecord(entry, project.id, order);
    if (!previousBlobs.has(id)) {
      // `add`, never `put`: an id another Project already uses must fail, not take over its entry.
      await tx.objectStore('screenshots').add({ id, blob });
      await tx.objectStore('entries').add(record);
      continue;
    }
    if (previousBlobs.get(id) !== blob) await tx.objectStore('screenshots').put({ id, blob });
    await tx.objectStore('entries').put(record);
  }

  const updated = sanitizeProject({
    ...project,
    ...summary,
    sections: repairProjectSections(sections, entries),
    updatedAt: Math.max(project.updatedAt, timestamp, Date.now()),
    contentRevision: project.contentRevision + 1,
  });
  await tx.objectStore('projects').put(updated);
  return { project: updated, entries };
}

/** Writes one entry's steps in place, without changing the timeline: the
 * entry keeps its place and its steps keep their numbers. */
export async function putEntryInPlace(tx: ProjectWriteTransaction, record: StoredEntry, entry: StepEntry): Promise<void> {
  if (entryId(entry) !== record.id || entry.kind !== record.kind) {
    throw new ProjectStructureIntegrityError('An in-place edit cannot change what an entry holds.');
  }
  const [normalized] = normalizeEntries([entry], record.projectId, record.owner.order);
  await tx.objectStore('entries').put(toRecord(normalized!, record.projectId, record.order));
}

/** Flattens entries into the steps they hold, in timeline order. */
export function entrySteps(entries: readonly StepEntry[]): Step[] {
  return entries.flatMap((entry) => (entry.kind === 'single' ? [entry.step] : [entry.anchor, ...entry.annotations]));
}
