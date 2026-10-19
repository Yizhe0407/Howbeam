import { PERSISTED_STEP_LIMITS } from '../storage/persistence-limits';

/** Common localStorage key prefix for every draft-journal record. Exported so
 * cross-tab `storage` listeners can filter on it without hardcoding a copy. */
export const DESCRIPTION_DRAFT_KEY_PREFIX = 'howbeam:editor-description-draft:';

const METADATA_PREFIX = `${DESCRIPTION_DRAFT_KEY_PREFIX}v2:meta:`;
const CHUNK_PREFIX = `${DESCRIPTION_DRAFT_KEY_PREFIX}v2:chunk:`;
const WRITER_SESSION_KEY = `${DESCRIPTION_DRAFT_KEY_PREFIX}writer:v1`;
const JOURNAL_VERSION = 2;
const CHUNK_CODE_UNITS = 4_096;
const MAX_DRAFT_RECORDS = 32;
const MAX_TOTAL_DRAFT_CODE_UNITS = 2_000_000;
const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const ORPHAN_GRACE_MS = 5 * 60 * 1_000;
const FUTURE_CLOCK_SKEW_MS = 60_000;

interface DraftStepIdentity {
  id: string;
  sessionId: string;
  description: string;
}

interface PersistedDescriptionDraftMetadata {
  version: typeof JOURNAL_VERSION;
  writerId: string;
  stepId: string;
  sessionId: string;
  baseLength: number;
  descriptionLength: number;
  baseChunks: string[];
  descriptionChunks: string[];
  updatedAt: number;
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

function encodedStepKey(step: Pick<DraftStepIdentity, 'id' | 'sessionId'>): string {
  return `${encodeURIComponent(step.sessionId)}:${encodeURIComponent(step.id)}`;
}

function recordId(step: Pick<DraftStepIdentity, 'id' | 'sessionId'>, writerId: string): string {
  return `${encodedStepKey(step)}:${encodeURIComponent(writerId)}`;
}

function metadataKey(step: Pick<DraftStepIdentity, 'id' | 'sessionId'>, writerId: string): string {
  return `${METADATA_PREFIX}${recordId(step, writerId)}`;
}

function chunkOwnerPrefix(metadata: PersistedDescriptionDraftMetadata): string {
  return `${CHUNK_PREFIX}${recordId(
    { id: metadata.stepId, sessionId: metadata.sessionId },
    metadata.writerId,
  )}:`;
}

function isValidDescription(value: unknown): value is string {
  return typeof value === 'string' && value.length <= PERSISTED_STEP_LIMITS.maxDescriptionLength;
}

function isValidLength(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= PERSISTED_STEP_LIMITS.maxDescriptionLength;
}

function parseMetadata(raw: string | null): PersistedDescriptionDraftMetadata | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PersistedDescriptionDraftMetadata> | null;
    if (
      !value ||
      value.version !== JOURNAL_VERSION ||
      !isValidIdentifier(value.writerId) ||
      !isValidIdentifier(value.stepId) ||
      !isValidIdentifier(value.sessionId) ||
      !isValidLength(value.baseLength) ||
      !isValidLength(value.descriptionLength) ||
      !Array.isArray(value.baseChunks) ||
      !Array.isArray(value.descriptionChunks) ||
      value.baseChunks.length !== Math.ceil(value.baseLength / CHUNK_CODE_UNITS) ||
      value.descriptionChunks.length !== Math.ceil(value.descriptionLength / CHUNK_CODE_UNITS) ||
      !value.baseChunks.every((key) => typeof key === 'string' && key.startsWith(CHUNK_PREFIX)) ||
      !value.descriptionChunks.every((key) => typeof key === 'string' && key.startsWith(CHUNK_PREFIX)) ||
      !Number.isFinite(value.updatedAt)
    ) return null;
    const metadata = value as PersistedDescriptionDraftMetadata;
    const owner = chunkOwnerPrefix(metadata);
    if (![...metadata.baseChunks, ...metadata.descriptionChunks].every((key) => key.startsWith(owner))) return null;
    return metadata;
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

function removeMetadataRecord(storage: Storage, key: string, metadata: PersistedDescriptionDraftMetadata | null): void {
  removeSafely(storage, key);
  if (!metadata || key !== metadataKey({ id: metadata.stepId, sessionId: metadata.sessionId }, metadata.writerId)) return;
  const owner = chunkOwnerPrefix(metadata);
  for (const chunkKey of new Set([...metadata.baseChunks, ...metadata.descriptionChunks])) {
    if (chunkKey.startsWith(owner)) removeSafely(storage, chunkKey);
  }
}

function readChunkedValue(storage: Storage, keys: readonly string[], expectedLength: number, owner: string): string | null {
  let result = '';
  try {
    for (const key of keys) {
      if (!key.startsWith(owner)) return null;
      const chunk = storage.getItem(key);
      if (chunk === null || chunk.length > CHUNK_CODE_UNITS) return null;
      result += chunk;
    }
  } catch {
    return null;
  }
  return result.length === expectedLength ? result : null;
}

function readMetadataValues(
  storage: Storage,
  metadata: PersistedDescriptionDraftMetadata,
): { baseDescription: string; description: string } | null {
  const owner = chunkOwnerPrefix(metadata);
  const baseDescription = readChunkedValue(storage, metadata.baseChunks, metadata.baseLength, owner);
  const description = readChunkedValue(storage, metadata.descriptionChunks, metadata.descriptionLength, owner);
  return baseDescription === null || description === null ? null : { baseDescription, description };
}

function storageKeys(storage: Storage): string[] | null {
  try {
    return Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
      (key): key is string => key !== null,
    );
  } catch {
    return null;
  }
}

function isExpired(updatedAt: number, now: number): boolean {
  return now - updatedAt > DRAFT_MAX_AGE_MS || updatedAt > now + FUTURE_CLOCK_SKEW_MS;
}

interface JournalRecordUsage {
  key: string;
  writerId: string;
  updatedAt: number;
  codeUnits: number;
  metadata: PersistedDescriptionDraftMetadata;
}

interface JournalUsage {
  count: number;
  codeUnits: number;
  referencedChunks: Set<string>;
  records: JournalRecordUsage[];
}

function scanUsage(storage: Storage, now: number): JournalUsage | null {
  const keys = storageKeys(storage);
  if (!keys) return null;
  let count = 0;
  let codeUnits = 0;
  const referencedChunks = new Set<string>();
  const records: JournalRecordUsage[] = [];
  try {
    for (const key of keys) {
      if (key.startsWith(METADATA_PREFIX)) {
        const metadata = parseMetadata(storage.getItem(key));
        if (
          !metadata ||
          key !== metadataKey({ id: metadata.stepId, sessionId: metadata.sessionId }, metadata.writerId) ||
          isExpired(metadata.updatedAt, now)
        ) {
          removeMetadataRecord(storage, key, metadata);
          continue;
        }
        const recordCodeUnits = metadata.baseLength + metadata.descriptionLength;
        count += 1;
        codeUnits += recordCodeUnits;
        records.push({ key, writerId: metadata.writerId, updatedAt: metadata.updatedAt, codeUnits: recordCodeUnits, metadata });
        for (const chunkKey of [...metadata.baseChunks, ...metadata.descriptionChunks]) referencedChunks.add(chunkKey);
      }
    }
    return { count, codeUnits, referencedChunks, records };
  } catch {
    return null;
  }
}

function orphanCreatedAt(key: string): number | null {
  const match = /:(?:base|description):(\d+)-[^:]+:\d+$/u.exec(key);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function pruneOldOrphanChunks(storage: Storage, referencedChunks: ReadonlySet<string>, now: number): void {
  const keys = storageKeys(storage);
  if (!keys) return;
  for (const key of keys) {
    if (!key.startsWith(CHUNK_PREFIX) || referencedChunks.has(key)) continue;
    const createdAt = orphanCreatedAt(key);
    // A grace period prevents another tab from deleting copy-on-write chunks
    // between that tab's chunk writes and its metadata commit.
    if (createdAt !== null && now - createdAt > ORPHAN_GRACE_MS) removeSafely(storage, key);
  }
}

function writeChunkedValue(
  storage: Storage,
  id: string,
  kind: 'base' | 'description',
  value: string,
  previousKeys: readonly string[],
  revision: string,
  createdKeys: string[],
): string[] | null {
  const keys: string[] = [];
  try {
    for (let index = 0; index < Math.ceil(value.length / CHUNK_CODE_UNITS); index += 1) {
      const chunk = value.slice(index * CHUNK_CODE_UNITS, (index + 1) * CHUNK_CODE_UNITS);
      const previousKey = previousKeys[index];
      if (previousKey && storage.getItem(previousKey) === chunk) {
        keys.push(previousKey);
        continue;
      }
      const key = `${CHUNK_PREFIX}${id}:${kind}:${revision}:${index}`;
      storage.setItem(key, chunk);
      createdKeys.push(key);
      keys.push(key);
    }
    return keys;
  } catch {
    return null;
  }
}

/** Copy-on-write chunking keeps a crash-safe synchronous write bounded: normal
 * typing updates one 4 KiB chunk plus metadata instead of rewriting 100,000
 * characters. Metadata is committed last, so interrupted writes retain the
 * previous complete record. */
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

  const key = metadataKey(step, writerId);
  const usage = scanUsage(storage, now);
  if (!usage) return false;
  // Reclaim stale crash leftovers before allocating. Waiting until a successful
  // write creates a deadlock when those orphan chunks are what exhausted the
  // localStorage quota in the first place. Fresh cross-tab chunks remain
  // protected by ORPHAN_GRACE_MS.
  pruneOldOrphanChunks(storage, usage.referencedChunks, now);

  let previous: PersistedDescriptionDraftMetadata | null;
  try {
    previous = parseMetadata(storage.getItem(key));
    if (previous && readMetadataValues(storage, previous) === null) {
      usage.count = Math.max(0, usage.count - 1);
      usage.codeUnits = Math.max(0, usage.codeUnits - previous.baseLength - previous.descriptionLength);
      removeMetadataRecord(storage, key, previous);
      previous = null;
    }
  } catch {
    return false;
  }

  const previousCodeUnits = previous ? previous.baseLength + previous.descriptionLength : 0;
  let nextCount = usage.count + (previous ? 0 : 1);
  let nextCodeUnits = usage.codeUnits - previousCodeUnits + step.description.length + description.length;
  if (nextCount > MAX_DRAFT_RECORDS || nextCodeUnits > MAX_TOTAL_DRAFT_CODE_UNITS) {
    // The bounds protect localStorage, not abandoned drafts: refusing the
    // write here would silently stop journaling live typing once dead tabs
    // accumulate 32 records. Evict other writers' records oldest-first
    // instead. This tab's own drafts for other steps are never evicted —
    // they may be the only copy of text this same user just typed.
    const evictable = usage.records
      .filter((record) => record.writerId !== writerId)
      .sort((left, right) => left.updatedAt - right.updatedAt);
    for (const record of evictable) {
      if (nextCount <= MAX_DRAFT_RECORDS && nextCodeUnits <= MAX_TOTAL_DRAFT_CODE_UNITS) break;
      removeMetadataRecord(storage, record.key, record.metadata);
      nextCount -= 1;
      nextCodeUnits -= record.codeUnits;
    }
    if (nextCount > MAX_DRAFT_RECORDS || nextCodeUnits > MAX_TOTAL_DRAFT_CODE_UNITS) return false;
  }

  const id = recordId(step, writerId);
  const revision = `${now}-${newUniqueId('revision')}`;
  const createdKeys: string[] = [];
  const baseChunks = writeChunkedValue(storage, id, 'base', step.description, previous?.baseChunks ?? [], revision, createdKeys);
  const descriptionChunks = writeChunkedValue(
    storage,
    id,
    'description',
    description,
    previous?.descriptionChunks ?? [],
    revision,
    createdKeys,
  );
  if (!baseChunks || !descriptionChunks) {
    for (const createdKey of createdKeys) removeSafely(storage, createdKey);
    return false;
  }

  const metadata: PersistedDescriptionDraftMetadata = {
    version: JOURNAL_VERSION,
    writerId,
    stepId: step.id,
    sessionId: step.sessionId,
    baseLength: step.description.length,
    descriptionLength: description.length,
    baseChunks,
    descriptionChunks,
    updatedAt: now,
  };
  try {
    storage.setItem(key, JSON.stringify(metadata));
  } catch {
    for (const createdKey of createdKeys) removeSafely(storage, createdKey);
    return false;
  }

  const retained = new Set([...baseChunks, ...descriptionChunks]);
  if (previous) {
    const owner = chunkOwnerPrefix(previous);
    for (const oldKey of new Set([...previous.baseChunks, ...previous.descriptionChunks])) {
      if (oldKey.startsWith(owner) && !retained.has(oldKey)) removeSafely(storage, oldKey);
    }
  }
  // The pre-allocation prune above already ran with these exact inputs; the
  // only chunks added since are this write's own, which stay referenced. A
  // second full-storage scan per keystroke would buy nothing.
  return true;
}

/** One scan over everything journaled for a step, shared by the read and clear paths so their
 * key-matching rules cannot drift apart. Storage failures propagate to the
 * caller, which owns the fail-soft policy. */
function forEachStepDraftRecord(
  storage: Storage,
  step: Pick<DraftStepIdentity, 'id' | 'sessionId'>,
  callback: (key: string, metadata: PersistedDescriptionDraftMetadata) => void,
): void {
  const keys = storageKeys(storage);
  if (!keys) return;
  const stepPrefix = `${METADATA_PREFIX}${encodedStepKey(step)}:`;
  for (const key of keys) {
    if (!key.startsWith(stepPrefix)) continue;
    const metadata = parseMetadata(storage.getItem(key));
    if (!metadata || metadata.stepId !== step.id || metadata.sessionId !== step.sessionId) continue;
    callback(key, metadata);
  }
}

/**
 * Returns all independently journaled versions for one step.
 *
 * Destructive side effects: this is also the journal's cleanup pass — it
 * removes expired, corrupt, over-limit, and value-matching records (plus
 * orphaned chunks) while scanning. Callers must therefore invoke it once per
 * mounted field (e.g. a lazy useState initializer), never per render.
 */
export function readDescriptionDrafts(
  step: DraftStepIdentity,
  currentWriterId = getDescriptionDraftWriterId(),
  storageOverride?: Storage,
  now = Date.now(),
): RestoredDescriptionDraft[] {
  const storage = resolveStorage(storageOverride);
  if (!storage || !isValidIdentifier(step.id) || !isValidIdentifier(step.sessionId) || !isValidDescription(step.description)) return [];
  const usage = scanUsage(storage, now);
  if (!usage) return [];
  const candidates: RestoredDescriptionDraft[] = [];

  try {
    forEachStepDraftRecord(storage, step, (key, metadata) => {
      const values = readMetadataValues(storage, metadata);
      if (!values || values.description === step.description) {
        removeMetadataRecord(storage, key, metadata);
        return;
      }
      candidates.push({
        writerId: metadata.writerId,
        description: values.description,
        updatedAt: metadata.updatedAt,
        belongsToCurrentWriter: metadata.writerId === currentWriterId,
        conflictsWithPersistedValue: values.baseDescription !== step.description,
      });
    });
  } catch {
    return [];
  }

  pruneOldOrphanChunks(storage, usage.referencedChunks, now);
  return candidates.sort((left, right) => right.updatedAt - left.updatedAt || left.writerId.localeCompare(right.writerId));
}

export function discardDescriptionDraft(
  step: Pick<DraftStepIdentity, 'id' | 'sessionId'>,
  writerId: string,
  storageOverride?: Storage,
): boolean {
  const storage = resolveStorage(storageOverride);
  if (!storage || !isValidIdentifier(step.id) || !isValidIdentifier(step.sessionId) || !isValidIdentifier(writerId)) return false;
  const key = metadataKey(step, writerId);
  try {
    const metadata = parseMetadata(storage.getItem(key));
    removeMetadataRecord(storage, key, metadata);
    return true;
  } catch {
    return false;
  }
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
  const key = metadataKey(step, writerId);
  try {
    const metadata = parseMetadata(storage.getItem(key));
    if (!metadata) return;
    const values = readMetadataValues(storage, metadata);
    if (values?.description === committedDescription) removeMetadataRecord(storage, key, metadata);
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
): void {
  const storage = resolveStorage(storageOverride);
  if (!storage) return;
  try {
    forEachStepDraftRecord(storage, step, (key, metadata) => {
      if (readMetadataValues(storage, metadata)?.description === committedDescription) {
        removeMetadataRecord(storage, key, metadata);
      }
    });
  } catch {
    // Best effort cleanup only; stale matching drafts are harmless and bounded.
  }
}

export const DESCRIPTION_DRAFT_JOURNAL_LIMITS = Object.freeze({
  maxRecords: MAX_DRAFT_RECORDS,
  maxTotalCodeUnits: MAX_TOTAL_DRAFT_CODE_UNITS,
  maxAgeMs: DRAFT_MAX_AGE_MS,
  chunkCodeUnits: CHUNK_CODE_UNITS,
  orphanGraceMs: ORPHAN_GRACE_MS,
});
