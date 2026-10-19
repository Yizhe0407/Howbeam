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
