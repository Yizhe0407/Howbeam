/**
 * The single rule for user-entered text that Howbeam persists and archives.
 *
 * Storage normalizes with it, the editor normalizes as the user types (so the
 * value it compares against is exactly what storage keeps), and the portable
 * archive validates with it. One rule means anything storage accepts can always
 * be exported and backed up, and an archive Howbeam wrote can always be read.
 *
 * Multi-line text (step descriptions, project titles and descriptions) keeps
 * tab, line feed and carriage return; every other C0 control, DEL and every C1
 * control (U+0080–U+009F, e.g. U+0085 NEXT LINE) is removed. Single-line labels
 * (tags, section titles) drop all of them, including tab and newlines.
 */
const DISALLOWED_TEXT_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const DISALLOWED_TEXT_CHARACTERS = new RegExp(DISALLOWED_TEXT_CHARACTER.source, 'gu');
const DISALLOWED_LINE_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/gu;

/** Removes the characters stored multi-line text may not contain. */
export function normalizeStoredText(value: string): string {
  return value.replace(DISALLOWED_TEXT_CHARACTERS, '');
}

/** Whether `value` already satisfies the stored multi-line text rule. */
export function isStoredText(value: string): boolean {
  return !DISALLOWED_TEXT_CHARACTER.test(value);
}

/** Removes every control character, for single-line labels. */
export function normalizeStoredLine(value: string): string {
  return value.replace(DISALLOWED_LINE_CHARACTERS, '');
}
