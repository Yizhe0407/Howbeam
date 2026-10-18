import { entryId, stepRole, type StepEntry } from '../storage/models';
import { isRecord } from '../shared/validation';
import {
  PROJECT_SECTION_LIMITS,
  sanitizeProjectSectionTitle,
  type ProjectSection,
} from '../storage/project-section-model';
export {
  PROJECT_SECTION_LIMITS,
  sanitizeProjectSectionTitle,
  type ProjectSection,
} from '../storage/project-section-model';

const IDENTIFIER_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

/**
 * Repairs untrusted or stale section metadata against the current renderable
 * timeline. Invalid records and later duplicates are dropped deterministically;
 * surviving sections are sorted into timeline order.
 *
 * Only complete StepEntry owners are valid boundaries. Snapshot annotation ids
 * are deliberately not added to the boundary map, so a section can never begin
 * in the middle of a shared-image annotation group.
 */
export function repairProjectSections(
  value: unknown,
  entries: readonly StepEntry[],
): ProjectSection[] {
  if (!Array.isArray(value) || value.length === 0 || entries.length === 0) return [];

  const boundaryOrder = collectEntryBoundaries(entries);
  if (boundaryOrder.size === 0) return [];

  const seenIds = new Set<string>();
  const seenStarts = new Set<string>();
  const repaired: Array<ProjectSection & { timelineIndex: number; inputIndex: number }> = [];
  const count = Math.min(value.length, PROJECT_SECTION_LIMITS.maxSections);

  for (let inputIndex = 0; inputIndex < count; inputIndex += 1) {
    const raw = value[inputIndex];
    if (!isRecord(raw)) continue;

    const id = validIdentifier(raw.id);
    const startEntryId = validIdentifier(raw.startEntryId);
    const title = sanitizeProjectSectionTitle(raw.title);
    if (!id || !startEntryId || !title) continue;

    const timelineIndex = boundaryOrder.get(startEntryId);
    if (timelineIndex === undefined || seenIds.has(id) || seenStarts.has(startEntryId)) continue;

    seenIds.add(id);
    seenStarts.add(startEntryId);
    repaired.push({ id, title, startEntryId, timelineIndex, inputIndex });
  }

  repaired.sort((left, right) => left.timelineIndex - right.timelineIndex || left.inputIndex - right.inputIndex);
  return repaired.map(({ id, title, startEntryId }) => ({ id, title, startEntryId }));
}

/** The section an entry falls under: the last one starting at or before it. */
export function sectionOfEntry(
  sections: readonly ProjectSection[],
  entries: readonly StepEntry[],
  index: number,
): ProjectSection | undefined {
  const byStart = new Map(sections.map((section) => [section.startEntryId, section]));
  for (let at = Math.min(index, entries.length - 1); at >= 0; at -= 1) {
    const section = byStart.get(entryId(entries[at]));
    if (section) return section;
  }
  return undefined;
}

function validIdentifier(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > PROJECT_SECTION_LIMITS.maxIdLength ||
    value.trim() !== value ||
    IDENTIFIER_CONTROL_CHARACTERS.test(value)
  ) {
    return null;
  }
  return value;
}

function collectEntryBoundaries(entries: readonly StepEntry[]): Map<string, number> {
  const result = new Map<string, number>();

  for (const [index, entry] of entries.entries()) {
    const id = completeEntryBoundaryId(entry);
    if (id && !result.has(id)) result.set(id, index);
  }

  return result;
}

function completeEntryBoundaryId(entry: StepEntry): string | null {
  if (entry.kind === 'single') {
    return entry.step.screenshotBlob instanceof Blob ? validIdentifier(entry.step.id) : null;
  }

  const anchorId = validIdentifier(entry.anchor.id);
  if (
    !anchorId ||
    !(entry.anchor.screenshotBlob instanceof Blob) ||
    stepRole(entry.anchor) !== 'anchor' ||
    entry.annotations.length === 0 ||
    // Every member must be an annotation of this exact group — a row whose
    // groupId points elsewhere is invalid even if it is an annotation.
    entry.annotations.some((annotation) => annotation.groupId !== anchorId || stepRole(annotation) !== 'annotation')
  ) {
    return null;
  }
  return anchorId;
}
