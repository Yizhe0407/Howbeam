import { repairProjectSections, type ProjectSection } from '../project/project-sections';
import { type StepEntry } from '../storage/models';
import { PERSISTED_STEP_LIMITS } from '../storage/persistence-limits';

export interface ProjectExportMetadata {
  /** 未指定 filename 時亦作為檔名來源。 */
  title?: string;
  description?: string;
  /** 副檔名由 projectExportFilename 加入。 */
  filename?: string;
  sections?: readonly ProjectSection[];
}

export interface ProjectExportOptions {
  signal?: AbortSignal;
}

export type ProjectExportFormat = 'markdown' | 'markdown-archive' | 'html' | 'pdf';

export interface ProjectMarkdownArchive {
  blob: Blob;
  markdownFilename: string;
  imageCount: number;
}

export const DEFAULT_TITLE = 'Howbeam Project';
const DEFAULT_FILENAME = 'howbeam-project';
export const IMAGE_MIME_TYPE = 'image/jpeg';
/** The credit at the end of every document, in English whatever the interface language. */
export const MADE_WITH = 'Made with Howbeam';

/** Shared by the HTML and PDF documents: black, white and greys only, so the
 * screenshots' red highlights are the one colour on the page. */
export const PROJECT_EXPORT_THEME = Object.freeze({
  text: '#1a1a1a',
  secondaryText: '#404040',
  mutedText: '#6b6b6b',
  rule: '#d4d4d4',
  /** Frame around exported screenshots. A touch darker than `rule`: an image
   * edge must read against near-white screenshot content. */
  imageBorder: '#cfcfcf',
  /** Corner radius of exported screenshots, in CSS pixels. */
  imageRadius: 10,
  /** CJK-capable system font stack for the HTML document's text; the PDF embeds its own font. */
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", "Helvetica Neue", Arial, sans-serif',
});

/** What a PDF adds to its screenshots: the embedded fonts and the page structure. */
const PDF_STRUCTURE_HEADROOM_BYTES = 16 * 1024 * 1024;

/** Derived from the persisted-step limits so every project accepted by storage
 * remains exportable; PDF budgets carry headroom (spill pages beyond one per
 * step, fonts and page structure on top of the screenshot payload, which a PDF
 * embeds as it is). The image total allows
 * twice the persisted screenshot payload — the same re-encode headroom as the
 * image-ZIP export, because both feed the renderEntryImages pipeline whose
 * annotated re-encodes can exceed their raw sources. */
export const PROJECT_EXPORT_LIMITS = Object.freeze({
  maxEntries: PERSISTED_STEP_LIMITS.maxStepsPerProject,
  maxImageBytes: PERSISTED_STEP_LIMITS.maxScreenshotBytes,
  maxTotalImageBytes: PERSISTED_STEP_LIMITS.maxTotalScreenshotBytes * 2,
  maxPdfPages: PERSISTED_STEP_LIMITS.maxStepsPerProject * 2,
  maxPdfBytes: PERSISTED_STEP_LIMITS.maxTotalScreenshotBytes * 2 + PDF_STRUCTURE_HEADROOM_BYTES,
});

export class ProjectExportLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectExportLimitError';
  }
}

/** 產生確定且檔案系統安全的名稱，確保重試結果穩定。 */
export function projectExportFilename(metadata: ProjectExportMetadata = {}, format: ProjectExportFormat): string {
  const extension = format === 'markdown' ? 'md' : format === 'markdown-archive' ? 'zip' : format;
  return `${projectFilenameStem(metadata)}.${extension}`;
}

/** Escapes text before placing it in generated HTML text or attribute content. */
export function escapeProjectHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case "'":
        return '&#39;';
      case '"':
        return '&quot;';
      default:
        return character;
    }
  });
}

/**
 * Escapes text for the Markdown constructs emitted by this module. This keeps
 * descriptions and titles text-only instead of allowing them to add links,
 * headings, HTML, or image syntax to the generated project.
 */
export function escapeProjectMarkdown(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/[[\]()<>`*_#!+\-|{}~=]/g, '\\$&')
    // GFM turns `http://…`, `www.…` and `user@host` into links, and the
    // backslashes above would end up inside the link target. Break the
    // trigger itself so the text stays plain text with no stray backslash in a URL.
    .replace(/:(?=\/\/)/g, '\\:')
    .replace(/\bwww\./gi, (match) => `${match.slice(0, 3)}\\.`)
    .replace(/@/g, '\\@')
    .replace(/\r\n?/g, '\n')
    // `1.` at a line start (up to three spaces of indent) would begin a real
    // ordered list - CommonMark even lets it interrupt a paragraph.
    .replace(/^( {0,3}\d+)\./gm, '$1\\.')
    .replace(/\n/g, '  \n');
}

/** Longest stem in UTF-8 bytes. File systems cap a name at 255 bytes (not
 * characters), so this leaves room for an extension and for callers that
 * append a suffix (backup filenames add an id and `.howbeam`). */
const FILENAME_STEM_MAX_BYTES = 200;

/** Device names Windows refuses as a file's base name (with any extension). */
const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

function utf8Length(codePoint: string): number {
  const value = codePoint.codePointAt(0) ?? 0;
  return value < 0x80 ? 1 : value < 0x800 ? 2 : value < 0x10000 ? 3 : 4;
}

export function projectFilenameStem(metadata: ProjectExportMetadata): string {
  const source = textValue(metadata.filename) || textValue(metadata.title);
  const stem = source
    .normalize('NFKD')
    // Latin accents are dropped on purpose (café -> cafe). Other combining
    // marks (kana voicing, Indic vowel signs, ...) are part of the letter.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Keep every Unicode letter, digit and combining mark so CJK titles
    // survive as filenames; everything else (separators, punctuation, path and
    // filesystem-unsafe characters, control characters) folds into single dashes.
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-')
    // Recompose what NFKD split apart (voiced kana, Hangul syllables).
    .normalize('NFC')
    .replace(/^-+|-+$/g, '');

  // Bound by UTF-8 bytes, a code point at a time so truncation can never leave
  // a lone surrogate, and never strand a combining mark away from its base.
  const codePoints = [...stem];
  let bytes = 0;
  let end = 0;
  while (end < codePoints.length && bytes + utf8Length(codePoints[end]) <= FILENAME_STEM_MAX_BYTES) {
    bytes += utf8Length(codePoints[end]);
    end += 1;
  }
  while (end < codePoints.length && end > 0 && /^\p{M}$/u.test(codePoints[end])) end -= 1;
  const bounded = codePoints.slice(0, end).join('').replace(/-+$/, '');

  if (!bounded) return DEFAULT_FILENAME;
  // `con.md` is invalid on Windows exactly like `con`; keep the name readable
  // but no longer a device name.
  return WINDOWS_RESERVED_NAMES.test(bounded) ? `${bounded}-${DEFAULT_FILENAME}` : bounded;
}

export function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function textOrDefault(value: unknown, fallback: string): string {
  const text = textValue(value).trim();
  return text || fallback;
}


export function sectionsByStartEntry(value: unknown, entries: readonly StepEntry[]): Map<string, ProjectSection> {
  return new Map(repairProjectSections(value, entries).map((section) => [section.startEntryId, section]));
}
