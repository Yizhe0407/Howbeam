import type { Point, Rect } from '../shared/geometry';
import { isRecord } from '../shared/validation';

/** Shared limits for live IndexedDB rows and portable project archives.
 * Keeping one source of truth guarantees every locally accepted step remains
 * representable by the backup/import format. */
export const PERSISTED_STEP_LIMITS = Object.freeze({
  maxStepsPerProject: 2_000,
  maxTotalScreenshotBytes: 64 * 1024 * 1024,
  maxScreenshotBytes: 16 * 1024 * 1024,
  maxStepDescriptionLength: 500,
  maxAnnotationDescriptionLength: 200,
  maxUrlLength: 8_192,
  maxIdLength: 256,
  maxRedactionsPerStep: 1_000,
  maxImageEditsPerStep: 500,
  maxImageEditTextLength: 1_000,
  maxCoordinateMagnitude: 10_000_000,
  maxBoundsDimension: 1_000_000,
  maxPixelRatio: 32,
});

export const PERSISTED_PROJECT_LIMITS = Object.freeze({
  maxTitleLength: 80,
  maxDescriptionLength: 2_000,
});

const isCoordinate = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  Math.abs(value) <= PERSISTED_STEP_LIMITS.maxCoordinateMagnitude;

const isDimension = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= PERSISTED_STEP_LIMITS.maxBoundsDimension;

/** The one rule for a stored rectangle (highlights, crops, masks, drawn shapes), in storage and archives alike. */
export function isPersistedRect(value: unknown): value is Rect {
  return (
    isRecord(value) &&
    isCoordinate(value.x) &&
    isCoordinate(value.y) &&
    isDimension(value.width) &&
    isDimension(value.height) &&
    isCoordinate((value.x as number) + (value.width as number)) &&
    isCoordinate((value.y as number) + (value.height as number))
  );
}

/** The one rule for a stored point (arrow ends, marker centres). */
export function isPersistedPoint(value: unknown): value is Point {
  return isRecord(value) && isCoordinate(value.x) && isCoordinate(value.y);
}
