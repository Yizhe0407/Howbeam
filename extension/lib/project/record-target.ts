import { isRecord } from '../shared/validation';

/**
 * Where a popup-started run records: a brand-new Project (placed at the end of
 * a Series when `seriesId` is given), or an existing Project it appends to.
 */
export type RecordTarget =
  | { kind: 'new'; seriesId?: string }
  | { kind: 'project'; projectId: string };

/** The default, which every popup opening starts from. */
export const NEW_PROJECT_TARGET: RecordTarget = Object.freeze({ kind: 'new' });

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Reads a target back from storage; anything malformed is null. */
export function parseRecordTarget(value: unknown): RecordTarget | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'project') return isId(value.projectId) ? { kind: 'project', projectId: value.projectId } : null;
  if (value.kind !== 'new') return null;
  if (value.seriesId === undefined) return NEW_PROJECT_TARGET;
  return isId(value.seriesId) ? { kind: 'new', seriesId: value.seriesId } : null;
}
