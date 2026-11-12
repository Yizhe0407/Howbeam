import { messagesFor, t, type Messages } from './index';

/** Catalog sections whose plain-text entries a reply or stored state may name. */
type CopySection = 'background' | 'recaptureFlow' | 'runtime' | 'nav' | 'editor' | 'toolbar';

type TextKeys<T> = { [K in keyof T]: T[K] extends string ? K : never }[keyof T] & string;

/**
 * Names a piece of UI copy without choosing its language: `'background.nothingToUndo'`.
 * The background stores and replies with these, never with text, so stored
 * state holds no language and the page that shows it renders it in the
 * language the reader has chosen.
 */
export type CopyKey = { [S in CopySection]: `${S}.${TextKeys<Messages[S]>}` }[CopySection];

const SECTIONS: ReadonlySet<string> = new Set<CopySection>([
  'background',
  'recaptureFlow',
  'runtime',
  'nav',
  'editor',
  'toolbar',
]);

/** Untrusted input (stored state, a runtime reply) naming copy that exists. */
export function isCopyKey(value: unknown): value is CopyKey {
  if (typeof value !== 'string') return false;
  const dot = value.indexOf('.');
  const section = value.slice(0, dot);
  if (dot <= 0 || !SECTIONS.has(section)) return false;
  const entries = messagesFor('zh-TW')[section as CopySection] as Record<string, unknown>;
  const key = value.slice(dot + 1);
  return Object.hasOwn(entries, key) && typeof entries[key] === 'string';
}

/** The copy in the active language. */
export function copyText(key: CopyKey): string {
  const dot = key.indexOf('.');
  return (t()[key.slice(0, dot) as CopySection] as Record<string, string>)[key.slice(dot + 1)]!;
}
