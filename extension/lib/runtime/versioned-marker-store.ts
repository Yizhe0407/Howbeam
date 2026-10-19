import { browser } from 'wxt/browser';
import { isRecord } from '../shared/validation';

/**
 * A versioned one-way boolean marker persisted in extension-local storage:
 * `{ version, <flag>: true, <at>: timestamp }` under the key
 * `howbeam:<name>:v<version>`. Incrementing the version gives the marker a
 * brand-new key, so an older marker never suppresses a newer flow (a v1
 * permission decline does not silence a v2 ask).
 */
export type VersionedMarkerState<
  Version extends number,
  Flag extends string,
  At extends string,
> = { version: Version } & { [K in Flag]: true } & { [K in At]: number };

export interface VersionedMarkerStore<State> {
  readonly storageKey: string;
  /** Returns a valid marker, or null for missing, stale, or malformed data. */
  normalize(value: unknown): State | null;
  /** Reads and normalizes the persisted marker. */
  get(): Promise<State | null>;
  /** Whether a valid marker for this exact version is persisted. */
  isMarked(): Promise<boolean>;
  /** Persists the marker. Throws RangeError for a non-timestamp `at`. */
  mark(at?: number): Promise<State>;
  clear(): Promise<void>;
}

export function createVersionedMarkerStore<
  Version extends number,
  Flag extends string,
  At extends string,
>(options: {
  /** Key segment: the store persists under `howbeam:<name>:v<version>`. */
  name: string;
  version: Version;
  flagField: Flag;
  atField: At;
}): VersionedMarkerStore<VersionedMarkerState<Version, Flag, At>> {
  type State = VersionedMarkerState<Version, Flag, At>;
  const { name, version, flagField, atField } = options;
  const storageKey = `howbeam:${name}:v${version}`;

  // Computed keys defeat TypeScript's object-literal checking, but the shape
  // is exactly State by construction.
  const buildState = (at: number): State =>
    ({ version, [flagField]: true, [atField]: at }) as State;

  const normalize = (value: unknown): State | null => {
    if (!isRecord(value)) return null;
    const state = value;
    const at = state[atField];
    if (
      state.version !== version ||
      state[flagField] !== true ||
      typeof at !== 'number' ||
      !Number.isFinite(at) ||
      at < 0
    ) {
      return null;
    }
    return buildState(at);
  };

  return {
    storageKey,
    normalize,
    async get() {
      const stored = await browser.storage.local.get(storageKey);
      return normalize(stored[storageKey]);
    },
    async isMarked() {
      const stored = await browser.storage.local.get(storageKey);
      return normalize(stored[storageKey]) !== null;
    },
    async mark(at = Date.now()) {
      if (!Number.isFinite(at) || at < 0) {
        throw new RangeError(`${atField} must be a non-negative finite timestamp`);
      }
      const state = buildState(at);
      await browser.storage.local.set({ [storageKey]: state });
      return state;
    },
    async clear() {
      await browser.storage.local.remove(storageKey);
    },
  };
}
