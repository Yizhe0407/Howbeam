import { unzipSync } from 'fflate';
import { throwIfAborted } from '../shared/abort';
import { type Step } from '../storage/models';
import {
  ARCHIVE_MANIFEST_PATH,
  MANIFEST_KEYS,
  PROJECT_ARCHIVE_FORMAT,
  PROJECT_ARCHIVE_LIMITS,
  PROJECT_ARCHIVE_VERSION,
  ProjectArchiveError,
  SAFE_SCREENSHOT_MEDIA_TYPES,
  SCREENSHOT_KEYS,
  STEP_KEYS,
  archiveScreenshotPath,
  screenshotId,
  type ImportedProjectArchive,
  type JsonRecord,
  type ProjectArchiveImportOptions,
  type ProjectArchiveSource,
} from './project-archive-contract';
import {
  assertUniqueStepIds,
  assertExactKeys,
  canonicalStepComparator,
  expectArray,
  expectIdentifier,
  expectRecord,
  expectSafeInteger,
  expectString,
  fail,
  hasOwn,
  parseArchiveMetadata,
  remapImportedProject,
  validateGroups,
  validateRuntimeStep,
  validateScreenshotRaster,
} from './project-archive-validation';

const SCREENSHOT_ID = /^[0-9a-f]{64}$/;

async function sourceToBytes(source: ProjectArchiveSource, signal?: AbortSignal): Promise<Uint8Array> {
  throwIfAborted(signal);
  let bytes: Uint8Array;
  if (source instanceof Blob) {
    if (source.size > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes) {
      fail('ARCHIVE_TOO_LARGE', 'The project archive is too large.');
    }
    bytes = new Uint8Array(await source.arrayBuffer());
  } else if (source instanceof ArrayBuffer) {
    bytes = new Uint8Array(source);
  } else if (ArrayBuffer.isView(source)) {
    bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  } else {
    fail('INVALID_ARCHIVE', 'The project archive source has an unsupported type.');
  }
  throwIfAborted(signal);
  if (bytes.byteLength > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes) {
    fail('ARCHIVE_TOO_LARGE', 'The project archive is too large.');
  }
  return bytes;
}

/** Reads the ZIP's entries. Only stored (uncompressed) entries are accepted,
 * so no entry can expand beyond the archive's own size limit. */
function readEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const names = new Set<string>();
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (file) => {
        if (names.has(file.name)) fail('INVALID_ARCHIVE', `The archive contains ${JSON.stringify(file.name)} twice.`);
        names.add(file.name);
        if (file.compression !== 0 || file.size !== file.originalSize) {
          fail('INVALID_ARCHIVE', `${JSON.stringify(file.name)} must be stored uncompressed.`);
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ProjectArchiveError) throw error;
    fail('INVALID_ARCHIVE', 'The project archive is not a valid Stepmark file.');
  }
  return new Map(Object.entries(files));
}

function parseManifest(bytes: Uint8Array | undefined): JsonRecord {
  if (!bytes) fail('INVALID_ARCHIVE', `The archive has no ${ARCHIVE_MANIFEST_PATH}.`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('INVALID_JSON', 'The project manifest is not valid UTF-8.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail('INVALID_JSON', 'The project manifest is not valid JSON.');
  }
  return expectRecord(parsed, 'manifest');
}

function parseArchiveStep(recordValue: unknown, path: string, screenshots: Map<string, Blob>, used: Set<string>): Step {
  const record = expectRecord(recordValue, path);
  assertExactKeys(record, STEP_KEYS, path);

  const runtime: JsonRecord = { ...record };
  delete runtime.screenshotId;
  if (hasOwn(record, 'screenshotId')) {
    const id = expectIdentifier(record.screenshotId, `${path}.screenshotId`);
    const blob = screenshots.get(id);
    if (!blob) fail('INVALID_BLOB', `${path} references missing screenshot ${JSON.stringify(id)}.`);
    runtime.screenshotBlob = blob;
    used.add(id);
  }
  return validateRuntimeStep(runtime, path);
}

/** Every screenshot the manifest lists must be the file its id names, byte for byte. */
async function parseScreenshots(
  value: unknown,
  entries: Map<string, Uint8Array>,
  signal?: AbortSignal,
): Promise<Map<string, Blob>> {
  const records = expectArray(value, 'manifest.screenshots');
  if (records.length > PROJECT_ARCHIVE_LIMITS.maxScreenshots) {
    fail('LIMIT_EXCEEDED', `An archive may contain at most ${PROJECT_ARCHIVE_LIMITS.maxScreenshots} screenshots.`);
  }

  const result = new Map<string, Blob>();
  let totalSize = 0;
  for (let index = 0; index < records.length; index += 1) {
    throwIfAborted(signal);
    const path = `manifest.screenshots[${index}]`;
    const record = expectRecord(records[index], path);
    assertExactKeys(record, SCREENSHOT_KEYS, path);
    const id = expectString(record.id, `${path}.id`, 64, false);
    if (!SCREENSHOT_ID.test(id)) fail('INVALID_BLOB', `${path}.id must be a SHA-256 hex digest.`);
    if (result.has(id)) fail('DUPLICATE_ID', `Duplicate screenshot id ${JSON.stringify(id)}.`);
    const mediaType = expectString(record.mediaType, `${path}.mediaType`, 64, false);
    if (!SAFE_SCREENSHOT_MEDIA_TYPES.has(mediaType)) {
      fail('INVALID_BLOB', `${path}.mediaType is not a supported raster screenshot type.`);
    }
    const size = expectSafeInteger(record.size, `${path}.size`, 1, PROJECT_ARCHIVE_LIMITS.maxScreenshotBytes);
    totalSize += size;
    if (totalSize > PROJECT_ARCHIVE_LIMITS.maxTotalScreenshotBytes) {
      fail('LIMIT_EXCEEDED', 'The screenshots exceed the total archive byte limit.');
    }

    const bytes = entries.get(archiveScreenshotPath(id, mediaType));
    if (!bytes) fail('INVALID_BLOB', `${path} has no file in the archive.`);
    if (bytes.byteLength !== size) fail('INVALID_BLOB', `${path} does not match its declared size.`);
    const owned = new Uint8Array(bytes);
    if (await screenshotId(owned) !== id) fail('INVALID_BLOB', `${path} does not match its SHA-256 id.`);
    throwIfAborted(signal);
    const blob = new Blob([owned], { type: mediaType });
    await validateScreenshotRaster(blob, path);
    throwIfAborted(signal);
    result.set(id, blob);
  }
  return result;
}

/** Strictly parses an archive into fresh, collision-resistant Step ids and screenshot Blobs. */
export async function importProjectArchive(
  source: ProjectArchiveSource,
  options: ProjectArchiveImportOptions = {},
): Promise<ImportedProjectArchive> {
  const { signal } = options;
  const entries = readEntries(await sourceToBytes(source, signal));
  throwIfAborted(signal);
  const manifest = parseManifest(entries.get(ARCHIVE_MANIFEST_PATH));

  // Read format/version before applying a concrete schema so future versions
  // fail explicitly instead of being misreported as an unknown-field error.
  if (manifest.format !== PROJECT_ARCHIVE_FORMAT) fail('INVALID_ARCHIVE', 'Unrecognized project archive format.');
  if (!Number.isSafeInteger(manifest.version)) fail('INVALID_ARCHIVE', 'manifest.version must be an integer.');
  if (manifest.version !== PROJECT_ARCHIVE_VERSION) {
    fail('UNSUPPORTED_VERSION', `Project archive version ${String(manifest.version)} is not supported.`);
  }
  assertExactKeys(manifest, MANIFEST_KEYS, 'manifest');

  const stepCount = expectSafeInteger(manifest.stepCount, 'manifest.stepCount', 0, PROJECT_ARCHIVE_LIMITS.maxSteps);
  const rawSteps = expectArray(manifest.steps, 'manifest.steps');
  if (rawSteps.length !== stepCount) fail('INVALID_ARCHIVE', 'manifest.stepCount does not match manifest.steps.length.');

  const screenshots = await parseScreenshots(manifest.screenshots, entries, signal);
  if (entries.size !== screenshots.size + 1) fail('INVALID_ARCHIVE', 'The archive contains files the manifest does not list.');
  const used = new Set<string>();
  const steps = rawSteps.map((step, index) => {
    throwIfAborted(signal);
    return parseArchiveStep(step, `manifest.steps[${index}]`, screenshots, used);
  });

  assertUniqueStepIds(steps);
  for (const id of screenshots.keys()) {
    if (!used.has(id)) fail('INVALID_BLOB', `Screenshot ${JSON.stringify(id)} is not referenced by a step.`);
  }
  validateGroups(steps);
  steps.sort(canonicalStepComparator);

  const metadata = parseArchiveMetadata(manifest.metadata, steps);
  const remapped = remapImportedProject(steps, metadata);
  throwIfAborted(signal);

  return { version: PROJECT_ARCHIVE_VERSION, steps: remapped.steps, metadata: remapped.metadata };
}
