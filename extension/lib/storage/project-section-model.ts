import { normalizeStoredLine } from './stored-text';

export interface ProjectSection {
  id: string;
  title: string;
  /** Stable id of a complete timeline entry (a single step or snapshot anchor). */
  startEntryId: string;
}

export const PROJECT_SECTION_LIMITS = Object.freeze({
  maxSections: 200,
  maxIdLength: 256,
  maxTitleLength: 60,
});

/**
 * Section titles are display-only text. Remove all control characters (including
 * newlines/tabs), trim surrounding whitespace, and cap storage/rendering cost.
 */
export function sanitizeProjectSectionTitle(value: unknown): string {
  return typeof value === 'string'
    ? normalizeStoredLine(value).trim().slice(0, PROJECT_SECTION_LIMITS.maxTitleLength)
    : '';
}
