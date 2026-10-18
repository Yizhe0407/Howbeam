import { repairProjectSections, type ProjectSection } from '../project/project-sections';
import { type StepEntry } from '../storage/models';
import { PERSISTED_STEP_LIMITS } from '../storage/persistence-limits';
import { intlLocale } from '@/lib/shared/i18n';

export interface ProjectExportMetadata {
  /** 未指定 filename 時亦作為檔名來源。 */
  title?: string;
  description?: string;
  /** 副檔名由 projectExportFilename 加入。 */
  filename?: string;
  sections?: readonly ProjectSection[];
  /** 僅供顯示的 epoch 毫秒，不影響檔名。 */
  createdAt?: number;
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

export const DEFAULT_TITLE = 'Stepmark Project';
const DEFAULT_FILENAME = 'stepmark-project';
export const IMAGE_MIME_TYPE = 'image/jpeg';

/** HTML 螢幕與 PDF 共用主題；HTML 列印仍使用省墨配色。 */
export const PROJECT_EXPORT_THEME = Object.freeze({
  text: '#1d2129',
  secondaryText: '#454d59',
  mutedText: '#6d7585',
  accent: '#3e63c4',
  rule: '#e2e5ea',
  /** Frame around exported screenshots in both documents. Deliberately the
   * PDF's slightly darker #d6dae1 rather than `rule`: an image edge must read
   * against near-white screenshot content, where the hairline value washes out. */
  imageBorder: '#d6dae1',
  /** CJK-capable system font stack shared by HTML text and PDF canvas rasterization. */
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", "Helvetica Neue", Arial, sans-serif',
});

/** Derived from the persisted-step limits so every project accepted by storage
 * remains exportable; PDF budgets carry headroom (spill pages beyond one per
 * step, page rasters on top of the screenshot payload). The image total allows
 * twice the persisted screenshot payload — the same re-encode headroom as the
 * image-ZIP export, because both feed the renderEntryImages pipeline whose
 * annotated re-encodes can exceed their raw sources. */
export const PROJECT_EXPORT_LIMITS = Object.freeze({
  maxEntries: PERSISTED_STEP_LIMITS.maxStepsPerProject,
  maxImageBytes: PERSISTED_STEP_LIMITS.maxScreenshotBytes,
  maxTotalImageBytes: PERSISTED_STEP_LIMITS.maxTotalScreenshotBytes * 2,
  maxPdfPages: PERSISTED_STEP_LIMITS.maxStepsPerProject * 2,
  maxPdfBytes: PERSISTED_STEP_LIMITS.maxTotalScreenshotBytes * 2,
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
 * append a suffix (backup filenames add an id and `.stepmark`). */
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

/** 時間戳缺少或無效時回傳空字串。 */
export function formatProjectCreatedAt(timestamp: unknown): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'long' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
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
