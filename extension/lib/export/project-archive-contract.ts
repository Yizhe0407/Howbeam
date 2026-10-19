import type { Bounds, ImageEdit, Redaction, Step } from '../storage/models';
import { PERSISTED_PROJECT_LIMITS, PERSISTED_STEP_LIMITS } from '../storage/persistence-limits';
import { PROJECT_SECTION_LIMITS, type ProjectSection } from '../storage/project-section-model';
import { SCREENSHOT_MEDIA_TYPES } from '../storage/screenshot-rules';

export const PROJECT_ARCHIVE_FORMAT = 'howbeam-project';
/** Version 4 is a ZIP: `manifest.json` plus each distinct screenshot stored
 * once, as its original bytes, under `screenshots/` named by its SHA-256. */
export const PROJECT_ARCHIVE_VERSION = 4;
export const PROJECT_ARCHIVE_MIME_TYPE = 'application/vnd.howbeam.project+zip';
export const ARCHIVE_MANIFEST_PATH = 'manifest.json';

const SCREENSHOT_EXTENSIONS: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** Where a screenshot lives inside the ZIP. Its id is the SHA-256 of its bytes. */
export function archiveScreenshotPath(id: string, mediaType: string): string {
  return `screenshots/${id}.${SCREENSHOT_EXTENSIONS[mediaType]}`;
}

/** Public limits are exported so callers can explain rejected imports before retrying. */
export const PROJECT_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 128 * 1024 * 1024,
  maxTotalScreenshotBytes: PERSISTED_STEP_LIMITS.maxTotalScreenshotBytes,
  maxScreenshotBytes: PERSISTED_STEP_LIMITS.maxScreenshotBytes,
  maxSteps: PERSISTED_STEP_LIMITS.maxStepsPerProject,
  maxScreenshots: PERSISTED_STEP_LIMITS.maxStepsPerProject,
  maxRedactionsPerStep: PERSISTED_STEP_LIMITS.maxRedactionsPerStep,
  maxImageEditsPerStep: PERSISTED_STEP_LIMITS.maxImageEditsPerStep,
  maxImageEditTextLength: PERSISTED_STEP_LIMITS.maxImageEditTextLength,
  maxIdLength: PERSISTED_STEP_LIMITS.maxIdLength,
  maxTitleLength: PERSISTED_PROJECT_LIMITS.maxTitleLength,
  maxProjectDescriptionLength: PERSISTED_PROJECT_LIMITS.maxDescriptionLength,
  maxSections: PROJECT_SECTION_LIMITS.maxSections,
  maxSectionTitleLength: PROJECT_SECTION_LIMITS.maxTitleLength,
  maxUrlLength: PERSISTED_STEP_LIMITS.maxUrlLength,
  maxCoordinateMagnitude: PERSISTED_STEP_LIMITS.maxCoordinateMagnitude,
  maxBoundsDimension: PERSISTED_STEP_LIMITS.maxBoundsDimension,
  maxPixelRatio: PERSISTED_STEP_LIMITS.maxPixelRatio,
});

export type ProjectArchiveErrorCode =
  | 'ARCHIVE_TOO_LARGE'
  | 'BROKEN_GROUP_REFERENCE'
  | 'DUPLICATE_ID'
  | 'INVALID_ARCHIVE'
  | 'INVALID_BLOB'
  | 'INVALID_JSON'
  | 'INVALID_IMAGE_EDIT'
  | 'INVALID_REDACTION'
  | 'LIMIT_EXCEEDED'
  | 'UNSAFE_URL'
  | 'UNSUPPORTED_VERSION';

export class ProjectArchiveError extends Error {
  constructor(
    public readonly code: ProjectArchiveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectArchiveError';
  }
}

export interface ProjectArchiveOptions {
  signal?: AbortSignal;
  /** Safe project metadata included in the archive. */
  metadata?: ProjectArchiveMetadataInput;
}

export interface ProjectArchiveImportOptions {
  signal?: AbortSignal;
}

export interface ProjectArchiveMetadataInput {
  title?: string;
  description?: string;
  sections?: readonly ProjectSection[];
}

export interface ProjectArchiveMetadata {
  title: string;
  description: string;
  sections: ProjectSection[];
}

export interface ImportedProjectArchive {
  version: typeof PROJECT_ARCHIVE_VERSION;
  steps: Step[];
  /** Section start ids already refer to the remapped ids in `steps`. */
  metadata: ProjectArchiveMetadata;
}

export type ProjectArchiveSource = Blob | ArrayBuffer | ArrayBufferView;

export type JsonRecord = Record<string, unknown>;

type ArchiveBounds = Bounds;
type ArchiveRedaction = Redaction;

export interface ArchiveStep {
  id: string;
  sessionId: string;
  runId?: string;
  order: number;
  screenshotId?: string;
  bounds: ArchiveBounds | null;
  manualBounds?: ArchiveBounds | null;
  redactions?: ArchiveRedaction[];
  redactionReviewRequired?: boolean;
  imageEdits?: ImageEdit[];
  crop?: ArchiveBounds;
  devicePixelRatio: number;
  screenshotScale?: number;
  description: string;
  url: string;
  timestamp: number;
  captureRevision?: number;
  imageEditRevision?: number;
  lastCaptureRunId?: string;
  groupId?: string;
  numbered?: boolean;
}

export interface ArchiveScreenshot {
  id: string;
  mediaType: string;
  size: number;
}

export interface ArchiveManifest {
  format: typeof PROJECT_ARCHIVE_FORMAT;
  version: typeof PROJECT_ARCHIVE_VERSION;
  stepCount: number;
  steps: ArchiveStep[];
  screenshots: ArchiveScreenshot[];
  metadata: ArchiveMetadata;
}

export interface ArchiveMetadata {
  title: string;
  description: string;
  sections: ProjectSection[];
}

export const MANIFEST_KEYS = ['format', 'version', 'stepCount', 'steps', 'screenshots', 'metadata'] as const;
export const METADATA_KEYS = ['title', 'description', 'sections'] as const;
export const SECTION_KEYS = ['id', 'title', 'startEntryId'] as const;
export const SCREENSHOT_KEYS = ['id', 'mediaType', 'size'] as const;
export const BOUNDS_KEYS = ['x', 'y', 'width', 'height'] as const;
export const REDACTION_KEYS = ['id', 'bounds', 'kind'] as const;
export const IMAGE_EDIT_KEYS = {
  text: ['id', 'kind', 'bounds', 'text', 'fontSize', 'color', 'look'],
  arrow: ['id', 'kind', 'from', 'to', 'width', 'color'],
  rect: ['id', 'kind', 'bounds', 'width', 'color', 'fill'],
  ellipse: ['id', 'kind', 'bounds', 'width', 'color', 'fill'],
  step: ['id', 'kind', 'center', 'radius', 'number', 'color'],
} as const;
export const POINT_KEYS = ['x', 'y'] as const;
export const STEP_KEYS = [
  'id',
  'sessionId',
  'runId',
  'order',
  'screenshotId',
  'bounds',
  'manualBounds',
  'redactions',
  'redactionReviewRequired',
  'imageEdits',
  'crop',
  'devicePixelRatio',
  'screenshotScale',
  'description',
  'url',
  'timestamp',
  'captureRevision',
  'imageEditRevision',
  'lastCaptureRunId',
  'groupId',
  'numbered',
] as const;
export const RUNTIME_STEP_KEYS = STEP_KEYS.map((key) => (key === 'screenshotId' ? 'screenshotBlob' : key));
/** The storage screenshot rule's media types: archives carry exactly what storage accepts. */
export const SAFE_SCREENSHOT_MEDIA_TYPES = SCREENSHOT_MEDIA_TYPES;

/** A screenshot's archive id: the hex SHA-256 of its bytes, so identical
 * screenshots share one file. */
export async function screenshotId(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
