import { throwIfAborted } from '../shared/abort';
import { type Step } from '../storage/models';
import {
  ARCHIVE_MANIFEST_PATH,
  PROJECT_ARCHIVE_FORMAT,
  PROJECT_ARCHIVE_LIMITS,
  PROJECT_ARCHIVE_MIME_TYPE,
  PROJECT_ARCHIVE_VERSION,
  STEP_KEYS,
  archiveScreenshotPath,
  screenshotId,
  type ArchiveManifest,
  type ArchiveScreenshot,
  type ArchiveStep,
  type ProjectArchiveOptions,
} from './project-archive-contract';
import {
  assertUniqueStepIds,
  archiveMetadataFromInput,
  canonicalStepComparator,
  fail,
  validateGroups,
  validateRuntimeStep,
  validateScreenshotRaster,
} from './project-archive-validation';
import { buildZipBlob } from './streaming-zip';

/**
 * Serialization is key-driven off STEP_KEYS — the same list the archive
 * validator enforces — so the serialized and validated shapes stay symmetric
 * structurally: a field added to STEP_KEYS round-trips automatically instead
 * of being silently dropped here. screenshotId is the one synthesized field;
 * the screenshot itself is written as its own file.
 */
function archiveStepFromRuntime(step: Step, id?: string): ArchiveStep {
  const archived: Partial<Record<(typeof STEP_KEYS)[number], unknown>> = {};
  for (const key of STEP_KEYS) {
    const value = key === 'screenshotId' ? id : step[key];
    if (value !== undefined) archived[key] = value;
  }
  return archived as ArchiveStep;
}

/** Validates the steps and collects each distinct screenshot once, in step order. */
async function buildManifest(
  stepsInput: readonly Step[],
  options: ProjectArchiveOptions,
): Promise<{ manifest: ArchiveManifest; files: Map<string, Uint8Array<ArrayBuffer>> }> {
  const { signal } = options;
  throwIfAborted(signal);
  if (!Array.isArray(stepsInput)) fail('INVALID_ARCHIVE', 'steps must be an array.');
  if (stepsInput.length > PROJECT_ARCHIVE_LIMITS.maxSteps) {
    fail('LIMIT_EXCEEDED', `An archive may contain at most ${PROJECT_ARCHIVE_LIMITS.maxSteps} steps.`);
  }

  const steps = stepsInput.map((step, index) => validateRuntimeStep(step, `steps[${index}]`));
  assertUniqueStepIds(steps);
  validateGroups(steps);
  steps.sort(canonicalStepComparator);
  const metadata = archiveMetadataFromInput(options.metadata, steps);

  const archivedSteps: ArchiveStep[] = [];
  const screenshots: ArchiveScreenshot[] = [];
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  let totalScreenshotBytes = 0;
  for (const [index, step] of steps.entries()) {
    throwIfAborted(signal);
    let id: string | undefined;
    if (step.screenshotBlob) {
      await validateScreenshotRaster(step.screenshotBlob, `steps[${index}].screenshotBlob`);
      throwIfAborted(signal);
      const bytes = new Uint8Array(await step.screenshotBlob.arrayBuffer());
      throwIfAborted(signal);
      id = await screenshotId(bytes);
      const path = archiveScreenshotPath(id, step.screenshotBlob.type);
      if (!files.has(path)) {
        totalScreenshotBytes += bytes.byteLength;
        if (totalScreenshotBytes > PROJECT_ARCHIVE_LIMITS.maxTotalScreenshotBytes) {
          fail('LIMIT_EXCEEDED', 'The screenshots exceed the total archive byte limit.');
        }
        files.set(path, bytes);
        screenshots.push({ id, mediaType: step.screenshotBlob.type, size: bytes.byteLength });
      }
    }
    archivedSteps.push(archiveStepFromRuntime(step, id));
  }

  return {
    manifest: {
      format: PROJECT_ARCHIVE_FORMAT,
      version: PROJECT_ARCHIVE_VERSION,
      stepCount: archivedSteps.length,
      steps: archivedSteps,
      screenshots,
      metadata,
    },
    files,
  };
}

/** Creates a self-contained project file: a ZIP holding the manifest and
 * every distinct screenshot once, as its original bytes. */
export async function exportProjectArchive(
  steps: readonly Step[],
  options: ProjectArchiveOptions = {},
): Promise<Blob> {
  const { manifest, files } = await buildManifest(steps, options);
  const zip = await buildZipBlob((addFile) => {
    addFile(ARCHIVE_MANIFEST_PATH, new TextEncoder().encode(JSON.stringify(manifest)));
    for (const [path, bytes] of files) addFile(path, bytes);
  });
  throwIfAborted(options.signal);
  if (zip.size > PROJECT_ARCHIVE_LIMITS.maxArchiveBytes) {
    fail('ARCHIVE_TOO_LARGE', 'The encoded project archive is too large.');
  }
  return new Blob([zip], { type: PROJECT_ARCHIVE_MIME_TYPE });
}
