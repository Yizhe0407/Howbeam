import {
  PROJECT_SECTION_LIMITS,
  sanitizeProjectSectionTitle,
  type ProjectSection,
} from './project-section-model';
import { isRecord } from '../shared/validation';
import { PERSISTED_PROJECT_LIMITS, PERSISTED_STEP_LIMITS } from './persistence-limits';
import { normalizeStoredText } from './stored-text';
import { cloneImageEdit, IMAGE_EDIT_LIMITS, readImageEdits, type ImageEdit } from './image-edit-model';
export type { ImageEdit } from './image-edit-model';
import { t } from '../shared/i18n';
export type { ProjectSection } from './project-section-model';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function isValidBounds(bounds: Bounds): boolean {
  return (
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    Math.abs(bounds.x) <= STEP_STORAGE_LIMITS.maxCoordinateMagnitude &&
    Math.abs(bounds.y) <= STEP_STORAGE_LIMITS.maxCoordinateMagnitude &&
    bounds.width > 0 &&
    bounds.height > 0 &&
    bounds.width <= STEP_STORAGE_LIMITS.maxBoundsDimension &&
    bounds.height <= STEP_STORAGE_LIMITS.maxBoundsDimension &&
    Math.abs(bounds.x + bounds.width) <= STEP_STORAGE_LIMITS.maxCoordinateMagnitude &&
    Math.abs(bounds.y + bounds.height) <= STEP_STORAGE_LIMITS.maxCoordinateMagnitude
  );
}

export interface Redaction {
  id: string;
  bounds: Bounds;
  /** Privacy-safe v1 intentionally supports only a fully opaque fill. */
  kind: 'solid';
}

export interface OrderedAnnotation {
  bounds: Bounds;
  order: number;
}

export interface Step {
  id: string;
  sessionId: string;
  /** Recording run that created this row. Editor-created rows omit it. */
  runId?: string;
  order: number;
  /** 僅一般步驟與快照 anchor 擁有原始截圖；寫入時移除標註副本。 */
  screenshotBlob?: Blob;
  /** Clicked element rect in CSS px, relative to the viewport at capture time. */
  bounds: Bounds | null;
  /** Non-destructive editor override. The original detected bounds stay intact
   * so a user can always restore the automatic selection. */
  manualBounds?: Bounds | null;
  /** Opaque privacy masks in screenshot CSS coordinates. Ordinary steps own
   * their masks; snapshot groups store them only on the shared anchor. */
  redactions?: Redaction[];
  /** Blocks normal preview/copy/export until masks are explicitly reviewed.
   * Set after recapturing an image that previously contained redactions, and
   * when malformed privacy metadata is detected during a write. */
  redactionReviewRequired?: boolean;
  /** Text, arrows and rectangles drawn on the image in the editor, in screenshot
   * CSS coordinates. Same ownership as `redactions`; painted beneath the masks. */
  imageEdits?: ImageEdit[];
  /** Non-destructive crop, in screenshot CSS coordinates, snapped to whole device
   * pixels. The stored image is never changed: previews and exports show only
   * this region, with every other coordinate shifted by its origin. Absent
   * (or null when clearing) means the whole image. */
  crop?: Bounds | null;
  devicePixelRatio: number;
  /** Actual screenshot pixels per CSS pixel, measured from the captured image. */
  screenshotScale?: number;
  description: string;
  url: string;
  timestamp: number;
  /** Incremented whenever a recapture replaces the screenshot Blob. */
  captureRevision?: number;
  /** Incremented on every write of `redactions`, `imageEdits` or `crop`, so an
   * image editor saving over a stale copy (another tab saved meanwhile) is
   * refused instead of silently dropping that tab's masks. Absent means 0. */
  imageEditRevision?: number;
  /** Durable marker used to recover a recapture after service-worker restart. */
  lastCaptureRunId?: string;
  /** 快照 anchor id；anchor 自我引用並擁有群組共用圖片。 */
  groupId?: string;
  /** Snapshot mode only: whether the group renders order-number badges.
   * Same value denormalized across every step sharing a groupId. */
  numbered?: boolean;
}

/** A locally persisted, editable project. `id` intentionally remains identical
 * to Step.sessionId so capture transaction guards share one stable identity. */
export interface Project {
  id: string;
  title: string;
  description: string;
  sections: ProjectSection[];
  createdAt: number;
  updatedAt: number;
  /** Monotonic generation of the Project's structure: which rows exist, their order and grouping. */
  contentRevision: number;
  /** Monotonic generation of in-place row edits: descriptions, image edits. */
  stepEditRevision: number;
  /** Monotonic generation of title and description. */
  metadataRevision: number;
  /** Denormalized summary fields kept transactionally in sync with `steps`. */
  stepCount: number;
  entryCount: number;
  storageBytes: number;
}

export type ProjectSummary = Project;

/** Runtime persistence limits mirror the portable project format so data that
 * can be recorded locally can always be backed up without unbounded memory or
 * IndexedDB growth. */
export const STEP_STORAGE_LIMITS = Object.freeze({
  ...PERSISTED_STEP_LIMITS,
  maxMutationItems: PERSISTED_STEP_LIMITS.maxStepsPerProject,
});

export class StepStorageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepStorageValidationError';
  }
}

export function storageError(message: string): never {
  throw new StepStorageValidationError(message);
}

export function requireStorageIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > STEP_STORAGE_LIMITS.maxIdLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    return storageError(`${field} is not a valid storage identifier.`);
  }
  return value;
}

function sanitizeStepText(value: unknown, maximum: number, field: string): string {
  if (typeof value !== 'string' || value.length > maximum) {
    return storageError(`${field} exceeds its storage limit.`);
  }
  return normalizeStoredText(value);
}

function sanitizeStepUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > STEP_STORAGE_LIMITS.maxUrlLength) {
    return storageError('Step URL exceeds its storage limit.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return storageError('Step URL must be a valid HTTP(S) URL.');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    return storageError('Step URL must be a credential-free HTTP(S) URL.');
  }
  return parsed.href;
}

function sanitizeNonNegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return storageError(`${field} must be a non-negative safe integer.`);
  }
  return value as number;
}

function sanitizePixelRatio(value: unknown, field: string): number {
  if (!Number.isFinite(value) || (value as number) <= 0 || (value as number) > STEP_STORAGE_LIMITS.maxPixelRatio) {
    return storageError(`${field} is outside the supported range.`);
  }
  return value as number;
}

export function assertMutationItems(
  values: readonly unknown[],
  field: string,
  identifiers = false,
): void {
  if (values.length > STEP_STORAGE_LIMITS.maxMutationItems) {
    storageError(`${field} exceeds the mutation item limit.`);
  }
  if (identifiers) {
    for (const value of values) requireStorageIdentifier(value, `${field} item`);
  }
}

function sanitizeProjectText(value: unknown, maximum: number): string {
  return typeof value === 'string'
    ? normalizeStoredText(value).trim().slice(0, maximum)
    : '';
}

/** An unnamed project stores an empty title; this is what to show for one. */
export function projectDisplayTitle(title: string): string {
  return title.trim() || t().common.untitledProject;
}

function nonNegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

function sanitizeProjectSectionsShape(value: unknown): ProjectSection[] {
  if (!Array.isArray(value)) return [];
  const sections: ProjectSection[] = [];
  const seenIds = new Set<string>();
  const seenStarts = new Set<string>();
  for (const raw of value.slice(0, PROJECT_SECTION_LIMITS.maxSections)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const candidate = raw as Partial<ProjectSection>;
    const id = typeof candidate.id === 'string' ? candidate.id : '';
    const startEntryId = typeof candidate.startEntryId === 'string' ? candidate.startEntryId : '';
    const title = sanitizeProjectSectionTitle(candidate.title);
    const validId = (identifier: string) => (
      identifier.length > 0
      && identifier.length <= PROJECT_SECTION_LIMITS.maxIdLength
      && identifier.trim() === identifier
      && !/[\u0000-\u001f\u007f-\u009f]/u.test(identifier)
    );
    if (!validId(id) || !validId(startEntryId) || !title || seenIds.has(id) || seenStarts.has(startEntryId)) continue;
    seenIds.add(id);
    seenStarts.add(startEntryId);
    sections.push({ id, title, startEntryId });
  }
  return sections;
}

export function sanitizeProject(project: Project): Project {
  const createdAt = Number.isFinite(project.createdAt) ? project.createdAt : Date.now();
  const updatedAt = Number.isFinite(project.updatedAt) ? Math.max(project.updatedAt, createdAt) : createdAt;
  const title = sanitizeProjectText(project.title, PERSISTED_PROJECT_LIMITS.maxTitleLength);
  return {
    id: project.id,
    title,
    description: sanitizeProjectText(project.description, PERSISTED_PROJECT_LIMITS.maxDescriptionLength),
    sections: sanitizeProjectSectionsShape((project as Project & { sections?: unknown }).sections),
    createdAt,
    updatedAt,
    contentRevision: nonNegativeInteger(project.contentRevision),
    stepEditRevision: nonNegativeInteger(project.stepEditRevision),
    metadataRevision: nonNegativeInteger(project.metadataRevision),
    stepCount: nonNegativeInteger(project.stepCount),
    entryCount: nonNegativeInteger(project.entryCount),
    storageBytes: nonNegativeInteger(project.storageBytes),
  };
}

export type ScreenshotStep = Step & { screenshotBlob: Blob };

export type StepEntry =
  | { kind: 'single'; step: ScreenshotStep }
  | { kind: 'group'; anchor: ScreenshotStep; annotations: Step[] };

export type StepRole = 'ordinary' | 'anchor' | 'annotation';

/** 僅分類拓撲；呼叫端依情境驗證圖片與 bounds。 */
export function stepRole(step: Pick<Step, 'id' | 'groupId'>): StepRole {
  if (!step.groupId) return 'ordinary';
  return step.id === step.groupId ? 'anchor' : 'annotation';
}

export function stepDescriptionLimit(step: Pick<Step, 'id' | 'groupId'>): number {
  return stepRole(step) === 'annotation'
    ? PERSISTED_STEP_LIMITS.maxAnnotationDescriptionLength
    : PERSISTED_STEP_LIMITS.maxStepDescriptionLength;
}

export function getEffectiveBounds(step: Pick<Step, 'bounds' | 'manualBounds'>): Bounds | null {
  if (step.manualBounds && isValidBounds(step.manualBounds)) return step.manualBounds;
  return step.bounds && isValidBounds(step.bounds) ? step.bounds : null;
}

export function getEntryImageOwner(entry: StepEntry): ScreenshotStep {
  return entry.kind === 'single' ? entry.step : entry.anchor;
}

export function isValidRedaction(value: unknown): value is Redaction {
  if (!isRecord(value)) return false;
  const redaction = value as Partial<Redaction>;
  return (
    typeof redaction.id === 'string' &&
    redaction.id.length > 0 &&
    redaction.id.length <= STEP_STORAGE_LIMITS.maxIdLength &&
    redaction.id.trim() === redaction.id &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(redaction.id) &&
    redaction.kind === 'solid' &&
    Boolean(redaction.bounds) &&
    isValidBounds(redaction.bounds as Bounds)
  );
}

export interface EntryPrivacyState {
  redactions: Redaction[];
  reviewRequired: boolean;
}

/** 穩定的 identity 可避免縮圖 ResizeObserver 每次 render 都重建。 */
const NO_REDACTIONS: Redaction[] = [];

/** Validates privacy metadata without silently treating corrupt masks as absent.
 * Any malformed record blocks ordinary rendering until the visual editor saves
 * a repaired, explicitly reviewed set. */
export function getEntryPrivacyState(entry: StepEntry): EntryPrivacyState {
  const owner = getEntryImageOwner(entry);
  const raw: unknown = owner.redactions;
  if (raw === undefined) {
    return { redactions: NO_REDACTIONS, reviewRequired: owner.redactionReviewRequired === true };
  }
  if (!Array.isArray(raw)) return { redactions: NO_REDACTIONS, reviewRequired: true };
  const rawItems = raw as unknown[];
  const redactions = rawItems.filter(isValidRedaction);
  if (redactions.length === rawItems.length) {
    // 預覽 hot path 保留 identity，避免重建 overlay observer。
    return { redactions: owner.redactions as Redaction[], reviewRequired: owner.redactionReviewRequired === true };
  }
  return {
    redactions,
    reviewRequired: owner.redactionReviewRequired === true || redactions.length !== rawItems.length,
  };
}

const EMPTY_IMAGE_EDITS: ImageEdit[] = [];
const readEditsCache = new WeakMap<object, ImageEdit[]>();

/** The drawable image edits of a timeline entry: stored on its image owner, with
 * anything malformed left out. Identity is stable per stored array so previews
 * don't re-render on every read. */
export function getEntryImageEdits(entry: StepEntry): ImageEdit[] {
  const raw: unknown = getEntryImageOwner(entry).imageEdits;
  if (!Array.isArray(raw) || raw.length === 0) return EMPTY_IMAGE_EDITS;
  let edits = readEditsCache.get(raw);
  if (!edits) {
    edits = readImageEdits(raw);
    readEditsCache.set(raw, edits);
  }
  return edits;
}

/** The crop of a timeline entry's image: the whole image when none is set. */
export function getEntryCrop(entry: StepEntry): Bounds | null {
  const crop = getEntryImageOwner(entry).crop;
  return crop && isValidBounds(crop) ? crop : null;
}

export function sanitizeStepForStorage(step: Step): Step {
  const id = requireStorageIdentifier(step.id, 'Step id');
  const sessionId = requireStorageIdentifier(step.sessionId, 'Step session id');
  const groupId = step.groupId === undefined
    ? undefined
    : requireStorageIdentifier(step.groupId, 'Step group id');
  const isSnapshotAnnotation = stepRole({ id, groupId }) === 'annotation';

  if (step.screenshotBlob !== undefined && !(step.screenshotBlob instanceof Blob)) {
    storageError('Step screenshot must be a Blob.');
  }
  if (step.screenshotBlob && step.screenshotBlob.size > STEP_STORAGE_LIMITS.maxScreenshotBytes) {
    storageError('Step screenshot exceeds the per-image storage limit.');
  }

  let redactions: Redaction[] | undefined;
  let redactionReviewRequired = step.redactionReviewRequired === true;
  if (!isSnapshotAnnotation && step.redactions !== undefined) {
    if (!Array.isArray(step.redactions)) {
      redactions = [];
      redactionReviewRequired = true;
    } else {
      if (step.redactions.length > STEP_STORAGE_LIMITS.maxRedactionsPerStep) {
        storageError('Step contains too many privacy redactions.');
      }
      const seen = new Set<string>();
      redactions = [];
      for (const redaction of step.redactions as unknown[]) {
        if (!isValidRedaction(redaction) || seen.has(redaction.id)) {
          redactionReviewRequired = true;
          continue;
        }
        seen.add(redaction.id);
        redactions.push({ id: redaction.id, kind: 'solid', bounds: { ...redaction.bounds } });
      }
    }
  }

  const crop = !isSnapshotAnnotation && step.crop && isValidBounds(step.crop) ? { ...step.crop } : undefined;
  let imageEdits: ImageEdit[] | undefined;
  if (!isSnapshotAnnotation && step.imageEdits !== undefined) {
    if (Array.isArray(step.imageEdits) && step.imageEdits.length > IMAGE_EDIT_LIMITS.maxItems) {
      storageError('Step contains too many image edits.');
    }
    imageEdits = readImageEdits(step.imageEdits).map(cloneImageEdit);
  }

  const sanitized: Step = {
    id,
    sessionId,
    order: sanitizeNonNegativeSafeInteger(step.order, 'Step order'),
    bounds: step.bounds === null || step.bounds === undefined
      ? null
      : isValidBounds(step.bounds) ? { ...step.bounds } : null,
    devicePixelRatio: sanitizePixelRatio(step.devicePixelRatio, 'Step device pixel ratio'),
    description: sanitizeStepText(step.description, stepDescriptionLimit(step), 'Step description'),
    url: sanitizeStepUrl(step.url),
    timestamp: sanitizeNonNegativeSafeInteger(step.timestamp, 'Step timestamp'),
  };

  if (step.runId !== undefined) sanitized.runId = requireStorageIdentifier(step.runId, 'Step run id');
  if (!isSnapshotAnnotation && step.screenshotBlob !== undefined) sanitized.screenshotBlob = step.screenshotBlob;
  if (step.manualBounds !== undefined) {
    sanitized.manualBounds = step.manualBounds !== null && isValidBounds(step.manualBounds)
      ? { ...step.manualBounds }
      : null;
  }
  if (redactions !== undefined) sanitized.redactions = redactions;
  if (imageEdits !== undefined) sanitized.imageEdits = imageEdits;
  if (crop !== undefined) sanitized.crop = crop;
  if (!isSnapshotAnnotation && redactionReviewRequired) sanitized.redactionReviewRequired = true;
  if (step.screenshotScale !== undefined) {
    sanitized.screenshotScale = sanitizePixelRatio(step.screenshotScale, 'Step screenshot scale');
  }
  if (step.captureRevision !== undefined) {
    sanitized.captureRevision = sanitizeNonNegativeSafeInteger(step.captureRevision, 'Step capture revision');
  }
  if (!isSnapshotAnnotation && step.imageEditRevision !== undefined) {
    sanitized.imageEditRevision = sanitizeNonNegativeSafeInteger(step.imageEditRevision, 'Step image edit revision');
  }
  if (step.lastCaptureRunId !== undefined) {
    sanitized.lastCaptureRunId = requireStorageIdentifier(step.lastCaptureRunId, 'Step last capture run id');
  }
  if (groupId !== undefined) sanitized.groupId = groupId;
  if (step.numbered !== undefined) sanitized.numbered = step.numbered === true;
  return sanitized;
}


/** 將已排序 row 分組；群組首次出現處決定其時間軸位置。 */
export function buildStepEntries(steps: Step[]): StepEntry[] {
  const entries: StepEntry[] = [];
  const seenGroups = new Set<string>();
  const groups = new Map<string, Step[]>();

  for (const step of steps) {
    if (!step.groupId) continue;
    const members = groups.get(step.groupId);
    if (members) members.push(step);
    else groups.set(step.groupId, [step]);
  }

  for (const step of steps) {
    if (!step.groupId) {
      // A partially-written/corrupt record without image data cannot be
      // rendered. Ignoring it keeps the rest of the session usable.
      if (step.screenshotBlob) entries.push({ kind: 'single', step: step as ScreenshotStep });
      continue;
    }
    if (seenGroups.has(step.groupId)) continue;
    seenGroups.add(step.groupId);
    const groupSteps = groups.get(step.groupId) ?? [];
    const anchor = groupSteps.find(
      (candidate): candidate is ScreenshotStep =>
        stepRole(candidate) === 'anchor' && candidate.screenshotBlob !== undefined,
    );

    if (anchor) {
      // 隱藏空 anchor，避免過時像素顯示為目前快照。
      const annotations = groupSteps.filter(
        (candidate) => stepRole(candidate) === 'annotation' && getEffectiveBounds(candidate) !== null,
      );
      if (annotations.length === 0) continue;
      entries.push({
        kind: 'group',
        anchor,
        annotations,
      });
      continue;
    }

  }

  return entries;
}

export function entryId(entry: StepEntry): string {
  return entry.kind === 'single' ? entry.step.id : entry.anchor.id;
}



export class ProjectStructureIntegrityError extends Error {
  constructor(message = 'Project timeline contains incomplete or split entries.') {
    super(message);
    this.name = 'ProjectStructureIntegrityError';
  }
}

export function orderedSessionSteps(steps: readonly Step[]): Step[] {
  return [...steps].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

/** DB mutations use a strict topology parser instead of the UI's fail-soft
 * buildStepEntries(). Every persisted row must belong to exactly one complete,
 * contiguous entry so a snapshot can never be partially mutated. */
export function buildCompleteStepEntries(
  steps: readonly Step[],
  expectedSessionId?: string,
  { skipPendingGroups = false }: { skipPendingGroups?: boolean } = {},
): StepEntry[] {
  const sorted = orderedSessionSteps(steps);
  const entries: StepEntry[] = [];
  const seenGroups = new Set<string>();
  const seenIds = new Set<string>();
  const lastGroupIndex = new Map<string, number>();
  sorted.forEach((step, index) => {
    if (step.groupId) lastGroupIndex.set(step.groupId, index);
  });

  for (let index = 0; index < sorted.length;) {
    const step = sorted[index];
    if (seenIds.has(step.id)) throw new ProjectStructureIntegrityError('Project contains duplicate step ids.');
    seenIds.add(step.id);
    if (expectedSessionId && step.sessionId !== expectedSessionId) {
      throw new ProjectStructureIntegrityError('Project contains a row from another session.');
    }
    if (!step.groupId) {
      if (!(step.screenshotBlob instanceof Blob)) {
        throw new ProjectStructureIntegrityError('An ordinary entry is missing its screenshot.');
      }
      entries.push({ kind: 'single', step: step as ScreenshotStep });
      index += 1;
      continue;
    }

    const groupId = step.groupId;
    if (seenGroups.has(groupId) || stepRole(step) !== 'anchor' || !(step.screenshotBlob instanceof Blob)) {
      throw new ProjectStructureIntegrityError('A snapshot group is missing its leading image anchor.');
    }
    seenGroups.add(groupId);
    const anchor = step as ScreenshotStep;
    const annotations: Step[] = [];
    index += 1;
    while (index < sorted.length && sorted[index].groupId === groupId) {
      const annotation = sorted[index];
      if (seenIds.has(annotation.id) || stepRole(annotation) !== 'annotation' || !getEffectiveBounds(annotation)) {
        throw new ProjectStructureIntegrityError('A snapshot group contains an invalid annotation.');
      }
      if (expectedSessionId && annotation.sessionId !== expectedSessionId) {
        throw new ProjectStructureIntegrityError('A snapshot group crosses Project boundaries.');
      }
      if (Boolean(annotation.numbered) !== Boolean(anchor.numbered)) {
        throw new ProjectStructureIntegrityError('A snapshot group has inconsistent numbering metadata.');
      }
      seenIds.add(annotation.id);
      annotations.push(annotation);
      index += 1;
    }
    if (annotations.length === 0) {
      // A snapshot being recorded owns its anchor from the moment it is captured, before the
      // first annotation exists. That is a normal state, not corruption, so a read-only view
      // may leave it out; anything that mutates the Project still refuses it.
      if (skipPendingGroups) continue;
      throw new ProjectStructureIntegrityError('A snapshot group has no complete annotation.');
    }
    if ((lastGroupIndex.get(groupId) ?? -1) >= index) {
      throw new ProjectStructureIntegrityError('A snapshot group is split across the timeline.');
    }
    entries.push({ kind: 'group', anchor, annotations });
  }
  return entries;
}

function entrySteps(entry: StepEntry): Step[] {
  return entry.kind === 'single' ? [entry.step] : [entry.anchor, ...entry.annotations];
}

export function flattenEntrySteps(entries: readonly StepEntry[]): Step[] {
  return entries.flatMap(entrySteps);
}

export function assertExactEntryIds(actualEntries: readonly StepEntry[], requestedIds: readonly string[]): void {
  if (requestedIds.length !== actualEntries.length || new Set(requestedIds).size !== requestedIds.length) {
    throw new ProjectStructureIntegrityError('Entry order must contain every entry exactly once.');
  }
  const actual = new Set(actualEntries.map(entryId));
  if (requestedIds.some((id) => !actual.has(id))) {
    throw new ProjectStructureIntegrityError('Entry order contains an unknown or annotation id.');
  }
}

/** Converts persisted annotation steps into the geometry contract shared by
 * previews, clipboard compositing, and exports. Invalid rows are
 * skipped instead of leaking non-null assertions into every caller. */
export function getOrderedAnnotations(steps: Step[]): OrderedAnnotation[] {
  const annotations: OrderedAnnotation[] = [];
  for (const step of steps) {
    const bounds = getEffectiveBounds(step);
    if (bounds) annotations.push({ bounds, order: annotations.length + 1 });
  }
  return annotations;
}
