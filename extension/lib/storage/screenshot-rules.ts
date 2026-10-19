import { RasterImageValidationError, validateRasterImageBlob } from '../capture/raster-image-validation';
import { PERSISTED_STEP_LIMITS } from './persistence-limits';
import { storageError } from './models';

/**
 * The single rule for a screenshot Blob that Howbeam persists and archives.
 * Storage refuses a write that breaks it and the portable archive validates
 * with it, so every stored screenshot can be exported and backed up. Each
 * caller wraps the returned problem in its own error type.
 */
export const SCREENSHOT_MEDIA_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** The cheap, synchronous part of the rule: a Blob of an allowed media type
 * holding between 1 byte and the per-image limit. Returns why it fails, or null. */
export function screenshotBlobProblem(blob: unknown): string | null {
  if (!(blob instanceof Blob)) return 'must be a Blob';
  if (blob.size <= 0 || blob.size > PERSISTED_STEP_LIMITS.maxScreenshotBytes) {
    return `must contain between 1 and ${PERSISTED_STEP_LIMITS.maxScreenshotBytes} bytes`;
  }
  if (!SCREENSHOT_MEDIA_TYPES.has(blob.type)) return `has unsupported media type ${JSON.stringify(blob.type)}`;
  return null;
}

/** The whole rule, including the image header: the bytes must be the declared
 * format and decode within the raster dimension and allocation limits. Only a
 * bounded header prefix is read. Returns why it fails, or null. */
export async function screenshotProblem(blob: unknown): Promise<string | null> {
  const problem = screenshotBlobProblem(blob);
  if (problem) return problem;
  try {
    await validateRasterImageBlob(blob as Blob);
    return null;
  } catch (error) {
    if (error instanceof RasterImageValidationError) return error.message;
    throw error;
  }
}

/** Refuses a write that would store a screenshot breaking the rule. Callers run
 * it before opening their IndexedDB transaction: reading the image header is
 * not an IndexedDB request, so awaiting it inside one would let it auto-commit. */
export async function assertStorableScreenshots(blobs: Iterable<Blob | undefined>): Promise<void> {
  for (const blob of blobs) {
    if (blob === undefined) continue;
    const problem = await screenshotProblem(blob);
    if (problem) storageError(`Step screenshot ${problem}.`);
  }
}
