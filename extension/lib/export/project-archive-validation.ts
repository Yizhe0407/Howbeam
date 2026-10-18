import { isRecord } from '../shared/validation';
import { buildStepEntries, stepRole, type Bounds, type ImageEdit, type Redaction, type Step } from '../storage/models';
import {
  IMAGE_EDIT_LIMITS,
  isImageEditColor,
  isShapeFill,
  isTextLook,
  type EditPoint,
  type ImageEditColor,
  type ShapeFill,
  type TextLook,
} from '../storage/image-edit-model';
import { screenshotBlobProblem, screenshotProblem } from '../storage/screenshot-rules';
import {
  repairProjectSections,
  sanitizeProjectSectionTitle,
  type ProjectSection,
} from '../project/project-sections';
import { sanitizeProjectTag } from '../storage/project-tag-model';
import { isStoredText } from '../storage/stored-text';
import {
  BOUNDS_KEYS,
  IMAGE_EDIT_KEYS,
  METADATA_KEYS,
  POINT_KEYS,
  PROJECT_ARCHIVE_LIMITS,
  REDACTION_KEYS,
  RUNTIME_STEP_KEYS,
  SECTION_KEYS,
  ProjectArchiveError,
  type ArchiveMetadata,
  type JsonRecord,
  type ProjectArchiveErrorCode,
  type ProjectArchiveMetadata,
  type ProjectArchiveMetadataInput,
} from './project-archive-contract';

/** Step ids address blobs and groups inside an archive, so a repeat makes the
 * manifest ambiguous. Both the export and import paths check it on their own
 * step shape. */
export function assertUniqueStepIds(steps: readonly { id: string }[]): void {
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) fail('DUPLICATE_ID', `Duplicate step id ${JSON.stringify(step.id)}.`);
    ids.add(step.id);
  }
}

export function fail(code: ProjectArchiveErrorCode, message: string): never {
  throw new ProjectArchiveError(code, message);
}

export function expectRecord(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) fail('INVALID_ARCHIVE', `${path} must be an object.`);
  return value;
}

export function assertExactKeys(value: JsonRecord, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail('INVALID_ARCHIVE', `${path} contains unknown field ${JSON.stringify(key)}.`);
  }
}

export function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail('INVALID_ARCHIVE', `${path} must be an array.`);
  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail('INVALID_ARCHIVE', `${path} must be a boolean.`);
  return value;
}

export function expectSafeInteger(
  value: unknown,
  path: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail('INVALID_ARCHIVE', `${path} must be a safe integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function expectFiniteNumber(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail('INVALID_ARCHIVE', `${path} must be a finite number between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function expectString(value: unknown, path: string, maximumLength: number, allowEmpty = true): string {
  if (typeof value !== 'string' || value.length > maximumLength || (!allowEmpty && value.length === 0)) {
    fail(
      'INVALID_ARCHIVE',
      `${path} must be ${allowEmpty ? '' : 'a non-empty '}string no longer than ${maximumLength} characters.`,
    );
  }
  return value;
}

export function expectIdentifier(value: unknown, path: string): string {
  const identifier = expectString(value, path, PROJECT_ARCHIVE_LIMITS.maxIdLength, false);
  if (identifier.trim() !== identifier || /[\u0000-\u001f\u007f-\u009f]/u.test(identifier)) {
    fail('INVALID_ARCHIVE', `${path} contains invalid whitespace or control characters.`);
  }
  return identifier;
}

function expectText(value: unknown, path: string, maximumLength: number): string {
  const text = expectString(value, path, maximumLength);
  // The same rule storage normalizes with, so every stored text is exportable.
  if (!isStoredText(text)) {
    fail('INVALID_ARCHIVE', `${path} contains invalid control characters.`);
  }
  return text;
}

function expectUrl(value: unknown, path: string): string {
  const raw = expectString(value, path, PROJECT_ARCHIVE_LIMITS.maxUrlLength, false);
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(raw)) fail('UNSAFE_URL', `${path} contains control characters.`);

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail('UNSAFE_URL', `${path} is not a valid absolute URL.`);
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.hostname) {
    fail('UNSAFE_URL', `${path} must use http or https.`);
  }
  if (parsed.username || parsed.password) fail('UNSAFE_URL', `${path} must not contain embedded credentials.`);
  return raw;
}

function expectBounds(value: unknown, path: string): Bounds {
  const record = expectRecord(value, path);
  assertExactKeys(record, BOUNDS_KEYS, path);
  return {
    x: expectFiniteNumber(
      record.x,
      `${path}.x`,
      -PROJECT_ARCHIVE_LIMITS.maxCoordinateMagnitude,
      PROJECT_ARCHIVE_LIMITS.maxCoordinateMagnitude,
    ),
    y: expectFiniteNumber(
      record.y,
      `${path}.y`,
      -PROJECT_ARCHIVE_LIMITS.maxCoordinateMagnitude,
      PROJECT_ARCHIVE_LIMITS.maxCoordinateMagnitude,
    ),
    width: expectFiniteNumber(
      record.width,
      `${path}.width`,
      Number.MIN_VALUE,
      PROJECT_ARCHIVE_LIMITS.maxBoundsDimension,
    ),
    height: expectFiniteNumber(
      record.height,
      `${path}.height`,
      Number.MIN_VALUE,
      PROJECT_ARCHIVE_LIMITS.maxBoundsDimension,
    ),
  };
}

function expectNullableBounds(value: unknown, path: string): Bounds | null {
  return value === null ? null : expectBounds(value, path);
}

function expectRedactions(value: unknown, path: string): Redaction[] {
  const input = expectArray(value, path);
  if (input.length > PROJECT_ARCHIVE_LIMITS.maxRedactionsPerStep) {
    fail('LIMIT_EXCEEDED', `${path} contains too many redactions.`);
  }

  const ids = new Set<string>();
  return input.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const record = expectRecord(item, itemPath);
    assertExactKeys(record, REDACTION_KEYS, itemPath);
    const id = expectIdentifier(record.id, `${itemPath}.id`);
    if (ids.has(id)) fail('DUPLICATE_ID', `${path} contains duplicate redaction id ${JSON.stringify(id)}.`);
    ids.add(id);
    if (record.kind !== 'solid') fail('INVALID_REDACTION', `${itemPath}.kind must be "solid".`);
    let bounds: Bounds;
    try {
      bounds = expectBounds(record.bounds, `${itemPath}.bounds`);
    } catch (error) {
      if (error instanceof ProjectArchiveError) {
        throw new ProjectArchiveError('INVALID_REDACTION', `${itemPath} has malformed bounds: ${error.message}`);
      }
      throw error;
    }
    return { id, bounds, kind: 'solid' };
  });
}

function expectEditColor(value: unknown, path: string): ImageEditColor {
  if (!isImageEditColor(value)) {
    fail('INVALID_IMAGE_EDIT', `${path} must be a colour written as #rrggbb.`);
  }
  return value;
}

function expectEditPoint(value: unknown, path: string): EditPoint {
  const record = expectRecord(value, path);
  assertExactKeys(record, POINT_KEYS, path);
  const limit = PROJECT_ARCHIVE_LIMITS.maxCoordinateMagnitude;
  return {
    x: expectFiniteNumber(record.x, `${path}.x`, -limit, limit),
    y: expectFiniteNumber(record.y, `${path}.y`, -limit, limit),
  };
}

function expectStrokeWidth(value: unknown, path: string): number {
  return expectFiniteNumber(value, path, IMAGE_EDIT_LIMITS.minStrokeWidth, IMAGE_EDIT_LIMITS.maxStrokeWidth);
}

function expectChoice<T extends string>(value: unknown, path: string, isChoice: (value: unknown) => value is T, choices: string): T {
  if (!isChoice(value)) fail('INVALID_IMAGE_EDIT', `${path} must be one of ${choices}.`);
  return value;
}

function expectImageEdits(value: unknown, path: string): ImageEdit[] {
  const input = expectArray(value, path);
  if (input.length > PROJECT_ARCHIVE_LIMITS.maxImageEditsPerStep) {
    fail('LIMIT_EXCEEDED', `${path} contains too many image edits.`);
  }
  const ids = new Set<string>();
  return input.map((item, index): ImageEdit => {
    const itemPath = `${path}[${index}]`;
    const record = expectRecord(item, itemPath);
    const kind = record.kind;
    if (kind !== 'text' && kind !== 'arrow' && kind !== 'rect' && kind !== 'ellipse' && kind !== 'step') {
      fail('INVALID_IMAGE_EDIT', `${itemPath}.kind must be "text", "arrow", "rect", "ellipse" or "step".`);
    }
    assertExactKeys(record, IMAGE_EDIT_KEYS[kind], itemPath);
    const id = expectIdentifier(record.id, `${itemPath}.id`);
    if (ids.has(id)) fail('DUPLICATE_ID', `${path} contains duplicate image edit id ${JSON.stringify(id)}.`);
    ids.add(id);
    const color = expectEditColor(record.color, `${itemPath}.color`);
    switch (kind) {
      case 'arrow':
        return {
          id, kind, color,
          from: expectEditPoint(record.from, `${itemPath}.from`),
          to: expectEditPoint(record.to, `${itemPath}.to`),
          width: expectStrokeWidth(record.width, `${itemPath}.width`),
        };
      case 'step':
        return {
          id, kind, color,
          center: expectEditPoint(record.center, `${itemPath}.center`),
          radius: expectFiniteNumber(record.radius, `${itemPath}.radius`, IMAGE_EDIT_LIMITS.minMarkerRadius, IMAGE_EDIT_LIMITS.maxMarkerRadius),
          number: expectSafeInteger(record.number, `${itemPath}.number`, 1, IMAGE_EDIT_LIMITS.maxMarkerNumber),
        };
      case 'rect':
      case 'ellipse':
        return {
          id, kind, color,
          bounds: expectBounds(record.bounds, `${itemPath}.bounds`),
          width: expectStrokeWidth(record.width, `${itemPath}.width`),
          fill: expectChoice<ShapeFill>(record.fill, `${itemPath}.fill`, isShapeFill, '"none" or "tint"'),
        };
      case 'text': {
        const text = expectText(record.text, `${itemPath}.text`, PROJECT_ARCHIVE_LIMITS.maxImageEditTextLength);
        if (text.length === 0) fail('INVALID_IMAGE_EDIT', `${itemPath}.text must not be empty.`);
        return {
          id, kind, color, text,
          bounds: expectBounds(record.bounds, `${itemPath}.bounds`),
          fontSize: expectFiniteNumber(record.fontSize, `${itemPath}.fontSize`, IMAGE_EDIT_LIMITS.minFontSize, IMAGE_EDIT_LIMITS.maxFontSize),
          look: expectChoice<TextLook>(record.look, `${itemPath}.look`, isTextLook, '"plain", "outline" or "box"'),
        };
      }
    }
  });
}

function expectOptionalString(record: JsonRecord, key: string, path: string): string | undefined {
  if (!hasOwn(record, key) || record[key] === undefined) return undefined;
  return expectIdentifier(record[key], `${path}.${key}`);
}

function expectOptionalBoolean(record: JsonRecord, key: string, path: string): boolean | undefined {
  if (!hasOwn(record, key) || record[key] === undefined) return undefined;
  return expectBoolean(record[key], `${path}.${key}`);
}

function expectOptionalNumber(
  record: JsonRecord,
  key: string,
  path: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (!hasOwn(record, key) || record[key] === undefined) return undefined;
  return expectFiniteNumber(record[key], `${path}.${key}`, minimum, maximum);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalStepComparator(
  a: Pick<Step, 'sessionId' | 'order' | 'id'>,
  b: Pick<Step, 'sessionId' | 'order' | 'id'>,
): number {
  return compareStrings(a.sessionId, b.sessionId) || a.order - b.order || compareStrings(a.id, b.id);
}

export function validateGroups(steps: readonly Step[]): void {
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const step of steps) {
    if (step.groupId === undefined) continue;
    const anchor = byId.get(step.groupId);
    if (!anchor || stepRole(anchor) !== 'anchor' || anchor.sessionId !== step.sessionId) {
      fail('BROKEN_GROUP_REFERENCE', `Step ${JSON.stringify(step.id)} has a broken group reference.`);
    }
    if (!anchor.screenshotBlob || anchor.bounds !== null) {
      fail('BROKEN_GROUP_REFERENCE', `Group anchor ${JSON.stringify(anchor.id)} is malformed.`);
    }
    if (anchor.numbered !== step.numbered) {
      fail('BROKEN_GROUP_REFERENCE', `Step ${JSON.stringify(step.id)} disagrees with its group anchor numbering.`);
    }
  }
}

function parseMetadataText(value: unknown, path: string, maximumLength: number): string {
  return expectText(value, path, maximumLength).trim();
}

function parseSectionRecords(value: unknown, path: string, steps: readonly Step[]): ProjectSection[] {
  const records = expectArray(value, path);
  if (records.length > PROJECT_ARCHIVE_LIMITS.maxSections) {
    fail('LIMIT_EXCEEDED', `An archive may contain at most ${PROJECT_ARCHIVE_LIMITS.maxSections} sections.`);
  }

  const sections: ProjectSection[] = records.map((section, index) => {
    const sectionPath = `${path}[${index}]`;
    const record = expectRecord(section, sectionPath);
    assertExactKeys(record, SECTION_KEYS, sectionPath);
    const id = expectString(record.id, `${sectionPath}.id`, PROJECT_ARCHIVE_LIMITS.maxIdLength);
    const title = expectString(
      record.title,
      `${sectionPath}.title`,
      PROJECT_ARCHIVE_LIMITS.maxSectionTitleLength,
    );
    const startEntryId = expectString(
      record.startEntryId,
      `${sectionPath}.startEntryId`,
      PROJECT_ARCHIVE_LIMITS.maxIdLength,
    );
    return { id, title: sanitizeProjectSectionTitle(title), startEntryId };
  });

  return repairProjectSections(sections, buildStepEntries([...steps]));
}

function parseTagRecords(value: unknown, path: string): string[] {
  const records = expectArray(value, path);
  if (records.length > PROJECT_ARCHIVE_LIMITS.maxTags) {
    fail('LIMIT_EXCEEDED', `An archive may contain at most ${PROJECT_ARCHIVE_LIMITS.maxTags} tags.`);
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  records.forEach((tag, index) => {
    const raw = expectString(tag, `${path}[${index}]`, PROJECT_ARCHIVE_LIMITS.maxTagLength);
    const sanitized = sanitizeProjectTag(raw);
    if (sanitized && !seen.has(sanitized)) {
      seen.add(sanitized);
      tags.push(sanitized);
    }
  });
  return tags;
}

export function parseArchiveMetadata(value: unknown, steps: readonly Step[], path = 'manifest.metadata'): ProjectArchiveMetadata {
  const record = expectRecord(value, path);
  assertExactKeys(record, METADATA_KEYS, path);
  return {
    title: parseMetadataText(record.title, `${path}.title`, PROJECT_ARCHIVE_LIMITS.maxTitleLength),
    description: parseMetadataText(
      record.description,
      `${path}.description`,
      PROJECT_ARCHIVE_LIMITS.maxProjectDescriptionLength,
    ),
    sections: parseSectionRecords(record.sections, `${path}.sections`, steps),
    // Archives written before tags existed omit this key entirely; treat
    // that as "no tags" rather than a malformed archive.
    tags: hasOwn(record, 'tags') ? parseTagRecords(record.tags, `${path}.tags`) : [],
  };
}

export function archiveMetadataFromInput(value: ProjectArchiveMetadataInput | undefined, steps: readonly Step[]): ArchiveMetadata {
  const record = expectRecord(value ?? {}, 'metadata');
  assertExactKeys(record, METADATA_KEYS, 'metadata');
  const title = hasOwn(record, 'title')
    ? parseMetadataText(record.title, 'metadata.title', PROJECT_ARCHIVE_LIMITS.maxTitleLength)
    : '';
  const description = hasOwn(record, 'description')
    ? parseMetadataText(
        record.description,
        'metadata.description',
        PROJECT_ARCHIVE_LIMITS.maxProjectDescriptionLength,
      )
    : '';
  const sections = hasOwn(record, 'sections')
    ? parseSectionRecords(record.sections, 'metadata.sections', steps)
    : [];
  const tags = hasOwn(record, 'tags') ? parseTagRecords(record.tags, 'metadata.tags') : [];
  return { title, description, sections, tags };
}

function freshImportId(used: Set<string>): string {
  let id: string;
  do id = crypto.randomUUID();
  while (used.has(id));
  used.add(id);
  return id;
}

export function remapImportedProject(
  steps: readonly Step[],
  metadata: ProjectArchiveMetadata,
): { steps: Step[]; metadata: ProjectArchiveMetadata } {
  const used = new Set<string>();
  const stepIds = new Map<string, string>();
  const sessionIds = new Map<string, string>();

  for (const step of steps) stepIds.set(step.id, freshImportId(used));
  for (const step of steps) {
    if (!sessionIds.has(step.sessionId)) sessionIds.set(step.sessionId, freshImportId(used));
  }

  const remappedSteps = steps.map((step) => ({
    ...step,
    id: stepIds.get(step.id)!,
    sessionId: sessionIds.get(step.sessionId)!,
    groupId: step.groupId === undefined ? undefined : stepIds.get(step.groupId),
  }));
  const remappedSections = metadata.sections.map((section) => ({
    ...section,
    startEntryId: stepIds.get(section.startEntryId) ?? '',
  }));

  return {
    steps: remappedSteps,
    metadata: {
      title: metadata.title,
      description: metadata.description,
      sections: repairProjectSections(remappedSections, buildStepEntries(remappedSteps)),
      tags: metadata.tags,
    },
  };
}

export function validateRuntimeStep(stepValue: unknown, path: string): Step {
  const record = expectRecord(stepValue, path);
  assertExactKeys(record, RUNTIME_STEP_KEYS, path);

  const id = expectIdentifier(record.id, `${path}.id`);
  const sessionId = expectIdentifier(record.sessionId, `${path}.sessionId`);
  const bounds = expectNullableBounds(record.bounds, `${path}.bounds`);
  const screenshotBlob = hasOwn(record, 'screenshotBlob') && record.screenshotBlob !== undefined
    ? record.screenshotBlob
    : undefined;
  if (screenshotBlob !== undefined && !(screenshotBlob instanceof Blob)) {
    fail('INVALID_BLOB', `${path}.screenshotBlob must be a Blob.`);
  }
  if (screenshotBlob) validateScreenshotBlob(screenshotBlob, `${path}.screenshotBlob`);

  const step: Step = {
    id,
    sessionId,
    order: expectSafeInteger(record.order, `${path}.order`),
    bounds,
    devicePixelRatio: expectFiniteNumber(
      record.devicePixelRatio,
      `${path}.devicePixelRatio`,
      Number.MIN_VALUE,
      PROJECT_ARCHIVE_LIMITS.maxPixelRatio,
    ),
    description: expectText(record.description, `${path}.description`, PROJECT_ARCHIVE_LIMITS.maxDescriptionLength),
    url: expectUrl(record.url, `${path}.url`),
    timestamp: expectSafeInteger(record.timestamp, `${path}.timestamp`),
  };

  if (screenshotBlob) step.screenshotBlob = screenshotBlob;
  const runId = expectOptionalString(record, 'runId', path);
  if (runId !== undefined) step.runId = runId;
  if (hasOwn(record, 'manualBounds') && record.manualBounds !== undefined) {
    step.manualBounds = expectNullableBounds(record.manualBounds, `${path}.manualBounds`);
  }
  if (hasOwn(record, 'redactions') && record.redactions !== undefined) {
    step.redactions = expectRedactions(record.redactions, `${path}.redactions`);
  }
  if (hasOwn(record, 'imageEdits') && record.imageEdits !== undefined) {
    step.imageEdits = expectImageEdits(record.imageEdits, `${path}.imageEdits`);
  }
  if (hasOwn(record, 'crop') && record.crop !== undefined) {
    step.crop = expectBounds(record.crop, `${path}.crop`);
  }
  const redactionReviewRequired = expectOptionalBoolean(record, 'redactionReviewRequired', path);
  if (redactionReviewRequired !== undefined) step.redactionReviewRequired = redactionReviewRequired;
  const screenshotScale = expectOptionalNumber(
    record,
    'screenshotScale',
    path,
    Number.MIN_VALUE,
    PROJECT_ARCHIVE_LIMITS.maxPixelRatio,
  );
  if (screenshotScale !== undefined) step.screenshotScale = screenshotScale;
  if (hasOwn(record, 'captureRevision') && record.captureRevision !== undefined) {
    step.captureRevision = expectSafeInteger(record.captureRevision, `${path}.captureRevision`);
  }
  if (hasOwn(record, 'imageEditRevision') && record.imageEditRevision !== undefined) {
    step.imageEditRevision = expectSafeInteger(record.imageEditRevision, `${path}.imageEditRevision`);
  }
  const lastCaptureRunId = expectOptionalString(record, 'lastCaptureRunId', path);
  if (lastCaptureRunId !== undefined) step.lastCaptureRunId = lastCaptureRunId;
  const groupId = expectOptionalString(record, 'groupId', path);
  if (groupId !== undefined) step.groupId = groupId;
  const numbered = expectOptionalBoolean(record, 'numbered', path);
  if (numbered !== undefined) step.numbered = numbered;
  return step;
}

// Screenshots follow the same rule storage enforces on write (screenshot-rules),
// so a stored project is always exportable.
function validateScreenshotBlob(blob: Blob, path: string): void {
  const problem = screenshotBlobProblem(blob);
  if (problem) fail('INVALID_BLOB', `${path} ${problem}.`);
}

export async function validateScreenshotRaster(blob: Blob, path: string): Promise<void> {
  const problem = await screenshotProblem(blob);
  if (problem) fail('INVALID_BLOB', `${path}: ${problem}`);
}
