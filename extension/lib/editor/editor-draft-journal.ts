import { PERSISTED_STEP_LIMITS } from '../storage/persistence-limits';
import type { StepTextField } from '../storage/models';

/** Common localStorage key prefix for every draft-journal record. Exported so
 * cross-tab `storage` listeners can filter on it without hardcoding a copy. */
export const TEXT_DRAFT_KEY_PREFIX = 'howbeam:editor-text-draft:';

const RECORD_PREFIX = `${TEXT_DRAFT_KEY_PREFIX}v4:`;
const WRITER_SESSION_KEY = `${TEXT_DRAFT_KEY_PREFIX}writer:v1`;
const JOURNAL_VERSION = 4;
const MAX_DRAFT_RECORDS = 32;
const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const FUTURE_CLOCK_SKEW_MS = 60_000;

/** Which text of which step a draft belongs to. */
export interface DraftTarget {
  id: string;
  sessionId: string;
  field: StepTextField;
}

/** A target with the value storage holds for it. */
export interface DraftStepIdentity extends DraftTarget {
  value: string;
}

interface PersistedTextDraft {
  version: typeof JOURNAL_VERSION;
  writerId: string;
  stepId: string;
  sessionId: string;
  field: StepTextField;
  baseValue: string;
  value: string;
  updatedAt: number;
}

interface JournalRecord {
  key: string;
  draft: PersistedTextDraft;
}

export interface RestoredTextDraft {
  writerId: string;
  value: string;
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

const MAX_TEXT_LENGTH = Math.max(PERSISTED_STEP_LIMITS.maxStepTitleLength, PERSISTED_STEP_LIMITS.maxStepDescriptionLength);

function isValidText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_TEXT_LENGTH;
}

function isValidField(value: unknown): value is StepTextField {
  return value === 'title' || value === 'description';
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
export function getTextDraftWriterId(): string {
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

function recordKey(target: DraftTarget, writerId: string): string {
  return `${RECORD_PREFIX}${encodeURIComponent(target.sessionId)}:${encodeURIComponent(target.id)}:${target.field}:${encodeURIComponent(writerId)}`;
}

function parseDraft(raw: string | null): PersistedTextDraft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PersistedTextDraft> | null;
    if (
      !value ||
      value.version !== JOURNAL_VERSION ||
      !isValidIdentifier(value.writerId) ||
      !isValidIdentifier(value.stepId) ||
      !isValidIdentifier(value.sessionId) ||
      !isValidField(value.field) ||
      !isValidText(value.baseValue) ||
      !isValidText(value.value) ||
      !Number.isFinite(value.updatedAt)
    ) return null;
    return value as PersistedTextDraft;
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
        key === recordKey({ id: draft.stepId, sessionId: draft.sessionId, field: draft.field }, draft.writerId);
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

function recordsForTarget(records: readonly JournalRecord[], target: DraftTarget): JournalRecord[] {
  return records.filter(({ draft }) => (
    draft.stepId === target.id && draft.sessionId === target.sessionId && draft.field === target.field
  ));
}

/** Each record is a single localStorage entry, so a write either lands whole or
 * leaves the previous record untouched. */
export function writeTextDraft(
  step: DraftStepIdentity,
  value: string,
  writerId = getTextDraftWriterId(),
  storageOverride?: Storage,
  now = Date.now(),
): boolean {
  const storage = resolveStorage(storageOverride);
  if (
    !storage ||
    !isValidIdentifier(step.id) ||
    !isValidIdentifier(step.sessionId) ||
    !isValidField(step.field) ||
    !isValidText(step.value) ||
    !isValidIdentifier(writerId) ||
    !isValidText(value)
  ) return false;
  if (value === step.value) return discardTextDraft(step, writerId, storage);

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

  const draft: PersistedTextDraft = {
    version: JOURNAL_VERSION,
    writerId,
    stepId: step.id,
    sessionId: step.sessionId,
    field: step.field,
    baseValue: step.value,
    value,
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
export function readTextDrafts(
  step: DraftStepIdentity,
  currentWriterId = getTextDraftWriterId(),
  storageOverride?: Storage,
  now = Date.now(),
): RestoredTextDraft[] {
  const storage = resolveStorage(storageOverride);
  if (
    !storage ||
    !isValidIdentifier(step.id) ||
    !isValidIdentifier(step.sessionId) ||
    !isValidField(step.field) ||
    !isValidText(step.value)
  ) return [];
  const records = scanRecords(storage, now);
  if (!records) return [];

  const candidates: RestoredTextDraft[] = [];
  for (const { key, draft } of recordsForTarget(records, step)) {
    if (draft.value === step.value) {
      removeSafely(storage, key);
      continue;
    }
    candidates.push({
      writerId: draft.writerId,
      value: draft.value,
      updatedAt: draft.updatedAt,
      belongsToCurrentWriter: draft.writerId === currentWriterId,
      conflictsWithPersistedValue: draft.baseValue !== step.value,
    });
  }
  return candidates.sort((left, right) => right.updatedAt - left.updatedAt || left.writerId.localeCompare(right.writerId));
}

export function discardTextDraft(
  target: DraftTarget,
  writerId: string,
  storageOverride?: Storage,
): boolean {
  const storage = resolveStorage(storageOverride);
  if (
    !storage ||
    !isValidIdentifier(target.id) ||
    !isValidIdentifier(target.sessionId) ||
    !isValidField(target.field) ||
    !isValidIdentifier(writerId)
  ) return false;
  return removeSafely(storage, recordKey(target, writerId));
}

/** Compare-and-clear prevents an older IndexedDB completion from deleting a
 * newer draft written by the same tab while that request was pending. */
export function clearCommittedTextDraft(
  target: DraftTarget,
  writerId: string,
  committedValue: string,
  storageOverride?: Storage,
): void {
  const storage = resolveStorage(storageOverride);
  if (!storage) return;
  const key = recordKey(target, writerId);
  try {
    if (parseDraft(storage.getItem(key))?.value === committedValue) removeSafely(storage, key);
  } catch {
    // The draft remains available for a later recovery attempt.
  }
}

/** Removes only candidates exactly equal to the authoritative IndexedDB value;
 * alternate drafts from other tabs remain selectable. */
export function clearMatchingCommittedTextDrafts(
  target: DraftTarget,
  committedValue: string,
  storageOverride?: Storage,
  now = Date.now(),
): void {
  const storage = resolveStorage(storageOverride);
  if (!storage) return;
  const records = scanRecords(storage, now);
  if (!records) return;
  for (const { key, draft } of recordsForTarget(records, target)) {
    if (draft.value === committedValue) removeSafely(storage, key);
  }
}

export const TEXT_DRAFT_JOURNAL_LIMITS = Object.freeze({
  maxRecords: MAX_DRAFT_RECORDS,
  maxAgeMs: DRAFT_MAX_AGE_MS,
});
