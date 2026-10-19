import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { type Step } from '../../storage/models';

/**
 * 單一待復原項目的持久化副本。MV3 可能在它成為唯一截圖副本時終止 worker，
 * 因此刻意延後清理。
 */
export interface PendingUndoRecord {
  token: string;
  runId: string;
  step: Step;
  expectedItemCount: number;
  expiresAt: number;
}

interface PendingUndoDB extends DBSchema {
  'pending-undo': {
    key: string;
    value: PendingUndoRecord;
  };
}

const DB_NAME = 'howbeam-pending-undo';
const STORE_NAME = 'pending-undo';
/** Undo is single-slot by design; a fixed key makes every save an overwrite. */
const RECORD_KEY = 'current';

let dbPromise: Promise<IDBPDatabase<PendingUndoDB>> | null = null;

function openPendingUndoDb(): Promise<IDBPDatabase<PendingUndoDB>> {
  dbPromise ??= openDB<PendingUndoDB>(DB_NAME, 1, {
    upgrade(database) {
      database.createObjectStore(STORE_NAME);
    },
  });
  return dbPromise;
}

function isPendingUndoRecord(value: unknown): value is PendingUndoRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<PendingUndoRecord>;
  return (
    typeof record.token === 'string' &&
    record.token.length > 0 &&
    typeof record.runId === 'string' &&
    record.runId.length > 0 &&
    typeof record.expectedItemCount === 'number' &&
    Number.isSafeInteger(record.expectedItemCount) &&
    record.expectedItemCount >= 0 &&
    typeof record.expiresAt === 'number' &&
    Number.isFinite(record.expiresAt) &&
    record.step != null &&
    typeof record.step === 'object'
  );
}

export async function savePendingUndoRecord(record: PendingUndoRecord): Promise<void> {
  const db = await openPendingUndoDb();
  await db.put(STORE_NAME, record, RECORD_KEY);
}

export async function readPendingUndoRecord(): Promise<PendingUndoRecord | null> {
  const db = await openPendingUndoDb();
  const record = await db.get(STORE_NAME, RECORD_KEY);
  return isPendingUndoRecord(record) ? record : null;
}

export async function clearPendingUndoRecord(): Promise<void> {
  const db = await openPendingUndoDb();
  await db.delete(STORE_NAME, RECORD_KEY);
}
