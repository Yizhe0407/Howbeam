import { PERSISTED_STEP_LIMITS } from '../storage/persistence-limits';

/** Common localStorage key prefix for every draft-journal record. Exported so
 * cross-tab `storage` listeners can filter on it without hardcoding a copy. */
export const DESCRIPTION_DRAFT_KEY_PREFIX = 'howbeam:editor-description-draft:';

const RECORD_PREFIX = `${DESCRIPTION_DRAFT_KEY_PREFIX}v3:`;
const WRITER_SESSION_KEY = `${DESCRIPTION_DRAFT_KEY_PREFIX}writer:v1`;
const JOURNAL_VERSION = 3;
const MAX_DRAFT_RECORDS = 32;
const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const FUTURE_CLOCK_SKEW_MS = 60_000;

interface DraftStepIdentity {
  id: string;
  sessionId: string;
  description: string;
}

interface PersistedDescriptionDraft {
  version: typeof JOURNAL_VERSION;
  writerId: string;
  stepId: string;
  sessionId: string;
  baseDescription: string;
  description: string;
  updatedAt: number;
}

interface JournalRecord {
  key: string;
  draft: PersistedDescriptionDraft;
}

export interface RestoredDescriptionDraft {
  writerId: string;
  description: string;
  updatedAt: number;
  belongsToCurrentWriter: boolean;
  /** True when IndexedDB changed after this draft was written. */
  conflictsWithPersistedValue: boolean;
}

let pageWriterId: string | null = null;
let fallbackSequence = 0;

function isValidIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= PERSISTED_STEP_LIMITS.maxIdLength &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

function isValidDescription(value: unknown): value is string {
  return typeof value === 'string' && value.length <= PERSISTED_STEP_LIMITS.maxStepDescriptionLength;
}

function newUniqueId(prefix: string): string {
  try {
    return crypto.randomUUID();
  } catch {
    fallbackSequence += 1;
    return `${prefix}-${Date.now()}-${fallbackSequence}-${Math.random().toString(36).slice(2)}`;
  }
}

function isReloadNavigation(): boolean {
  try {
    return performance.getEntriesByType('navigation').some(
      (entry) => (entry as PerformanceNavigationTiming).type === 'reload',
    );
  } catch {
    return false;
  }
}

/** A writer is stable across component remounts and a same-tab reload, but a
 * newly opened/duplicated tab rotates a cloned sessionStorage value. */
export function getDescriptionDraftWriterId(): string {
  if (pageWriterId) return pageWriterId;
  try {
    const stored = sessionStorage.getItem(WRITER_SESSION_KEY);
    if (stored && isValidIdentifier(stored) && isReloadNavigation()) {
      pageWriterId = stored;
      return pageWriterId;
    }
    pageWriterId = newUniqueId('writer');
    sessionStorage.setItem(WRITER_SESSION_KEY, pageWriterId);
  } catch {
    pageWriterId = newUniqueId('writer');
  }
  return pageWriterId;
}

function resolveStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function recordKey(step: Pick<DraftStepIdentity, 'id' | 'sessionId'>, writerId: string): string {
  return `${RECORD_PREFIX}${encodeURIComponent(step.sessionId)}:${encodeURIComponent(step.id)}:${encodeURIComponent(writerId)}`;
}

function parseDraft(raw: string | null): PersistedDescriptionDraft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PersistedDescriptionDraft> | null;
    if (
      !value ||
      value.version !== JOURNAL_VERSION ||
      !isValidIdentifier(value.writerId) ||
      !isValidIdentifier(value.stepId) ||
      !isValidIdentifier(value.sessionId) ||
      !isValidDescription(value.baseDescription) ||
      !isValidDescription(value.description) ||
      !Number.isFinite(value.updatedAt)
    ) return null;
    return value as PersistedDescriptionDraft;
  } catch {
    return null;
  }
}

function removeSafely(storage: Storage, key: string): boolean {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function isExpired(updatedAt: number, now: number): boolean {
  return now - updatedAt > DRAFT_MAX_AGE_MS || updatedAt > now + FUTURE_CLOCK_SKEW_MS;
}

/**
 * Every live record in the journal. This is also the cleanup pass: records
 * that are corrupt, filed under a key that does not match their contents, or
 * expired are removed while scanning. Returns null when storage is unreadable.
 */
function scanRecords(storage: Storage, now: number): JournalRecord[] | null {
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    const records: JournalRecord[] = [];
    for (const key of keys) {
      if (key === null || !key.startsWith(RECORD_PREFIX)) continue;
      const draft = parseDraft(storage.getItem(key));
      const filedCorrectly = draft !== null &&
        key === recordKey({ id: draft.stepId, sessionId: draft.sessionId }, draft.writerId);
      if (!draft || !filedCorrectly || isExpired(draft.updatedAt, now)) {
        removeSafely(storage, key);
        continue;
      }
      records.push({ key, draft });
    }
    return records;
  } catch {
    return null;
  }
}

function recordsForStep(records: readonly JournalRecord[], step: Pick<DraftStepIdentity, 'id' | 'sessionId'>): JournalRecord[] {
  return records.filter(({ draft }) => draft.stepId === step.id && draft.sessionId === step.sessionId);
}

/** Each record is a single localStorage entry, so a write either lands whole or
 * leaves the previous record untouched. */
export function writeDescriptionDraft(
  step: DraftStepIdentity,
  description: string,
  writerId = getDescriptionDraftWriterId(),
  storageOverride?: Storage,
  now = Date.now(),
): boolean {
  const storage = resolveStorage(storageOverride);
  if (
    !storage ||
    !isValidIdentifier(step.id) ||
    !isValidIdentifier(step.sessionId) ||
    !isValidDescription(step.description) ||
    !isValidIdentifier(writerId) ||
    !isValidDescription(description)
  ) return false;
  if (description === step.description) return discardDescriptionDraft(step, writerId, storage);

  const key = recordKey(step, writerId);
  const records = scanRecords(storage, now);
  if (!records) return false;

  let nextCount = records.length + (records.some((record) => record.key === key) ? 0 : 1);
  if (nextCount > MAX_DRAFT_RECORDS) {
    // The cap protects localStorage, not abandoned drafts: refusing the write
    // here would silently stop journaling live typing once dead tabs
    // accumulate 32 records. Evict other writers' records oldest-first
    // instead. This tab's own drafts for other steps are never evicted —
    // they may be the only copy of text this same user just typed.
    const evictable = records
      .filter((record) => record.draft.writerId !== writerId)
      .sort((left, right) => left.draft.updatedAt - right.draft.updatedAt);
    for (const record of evictable) {
      if (nextCount <= MAX_DRAFT_RECORDS) break;
      removeSafely(storage, record.key);
      nextCount -= 1;
    }
    if (nextCount > MAX_DRAFT_RECORDS) return false;
  }

  const draft: PersistedDescriptionDraft = {
    version: JOURNAL_VERSION,
    writerId,
    stepId: step.id,
    sessionId: step.sessionId,
    baseDescription: step.description,
    description,
    updatedAt: now,
  };
  try {
    storage.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns all independently journaled versions for one step.
 *
 * Destructive side effects: this is also the journal's cleanup pass — it
 * removes expired, corrupt, and value-matching records while scanning.
 * Callers must therefore invoke it once per mounted field (e.g. a lazy
 * useState initializer), never per render.
 */
export function readDescriptionDrafts(
  step: DraftStepIdentity,
  currentWriterId = getDescriptionDraftWriterId(),
  storageOverride?: Storage,
  now = Date.now(),
): RestoredDescriptionDraft[] {
  const storage = resolveStorage(storageOverride);
  if (!storage || !isValidIdentifier(step.id) || !isValidIdentifier(step.sessionId) || !isValidDescription(step.description)) return [];
  const records = scanRecords(storage, now);
  if (!records) return [];

  const candidates: RestoredDescriptionDraft[] = [];
  for (const { key, draft } of recordsForStep(records, step)) {
    if (draft.description === step.description) {
      removeSafely(storage, key);
      continue;
    }
    candidates.push({
      writerId: draft.writerId,
      description: draft.description,
      updatedAt: draft.updatedAt,
      belongsToCurrentWriter: draft.writerId === currentWriterId,
      conflictsWithPersistedValue: draft.baseDescription !== step.description,
    });
  }
  return candidates.sort((left, right) => right.updatedAt - left.updatedAt || left.writerId.localeCompare(right.writerId));
}

export function discardDescriptionDraft(
  step: Pick<DraftStepIdentity, 'id' | 'sessionId'>,
  writerId: string,
  storageOverride?: Storage,
): boolean {
  const storage = resolveStorage(storageOverride);
  if (!storage || !isValidIdentifier(step.id) || !isValidIdentifier(step.sessionId) || !isValidIdentifier(writerId)) return false;
  return removeSafely(storage, recordKey(step, writerId));
}

/** Compare-and-clear prevents an older IndexedDB completion from deleting a
 * newer draft written by the same tab while that request was pending. */
export function clearCommittedDescriptionDraft(
  step: Pick<DraftStepIdentity, 'id' | 'sessionId'>,
  writerId: string,
  committedDescription: string,
  storageOverride?: Storage,
): void {
  const storage = resolveStorage(storageOverride);
  if (!storage) return;
  const key = recordKey(step, writerId);
  try {
    if (parseDraft(storage.getItem(key))?.description === committedDescription) removeSafely(storage, key);
  } catch {
    // The draft remains available for a later recovery attempt.
  }
}

/** Removes only candidates exactly equal to the authoritative IndexedDB value;
 * alternate drafts from other tabs remain selectable. */
export function clearMatchingCommittedDescriptionDrafts(
  step: Pick<DraftStepIdentity, 'id' | 'sessionId'>,
  committedDescription: string,
  storageOverride?: Storage,
  now = Date.now(),
): void {
  const storage = resolveStorage(storageOverride);
  if (!storage) return;
  const records = scanRecords(storage, now);
  if (!records) return;
  for (const { key, draft } of recordsForStep(records, step)) {
    if (draft.description === committedDescription) removeSafely(storage, key);
  }
}

export const DESCRIPTION_DRAFT_JOURNAL_LIMITS = Object.freeze({
  maxRecords: MAX_DRAFT_RECORDS,
  maxAgeMs: DRAFT_MAX_AGE_MS,
});
