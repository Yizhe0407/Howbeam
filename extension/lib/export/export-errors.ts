/**
 * Typed export failures. They live in their own module so the publish dialog
 * can classify an error (and tell the user which step or which stage failed)
 * without importing the heavy renderers.
 */

/** One or more steps carry masks that still need a human review. Every export
 * format refuses (fail-closed) instead of publishing a blanked-out image. */
export class RedactionReviewRequiredError extends Error {
  /** 1-based step ordinals, in project order. */
  readonly ordinals: readonly number[];

  constructor(ordinals: readonly number[] = []) {
    super('Sensitive-information masks must be reviewed before export.');
    this.name = 'RedactionReviewRequiredError';
    this.ordinals = ordinals;
  }
}

/** A step's screenshot could not be decoded or composited. */
export class StepImageError extends Error {
  /** 1-based step ordinal. */
  readonly ordinal: number;

  constructor(ordinal: number, cause: unknown) {
    super(`Step ${ordinal} image could not be rendered.`, { cause });
    this.name = 'StepImageError';
    this.ordinal = ordinal;
  }
}

/** The browser refused or failed to queue the finished file. Distinct from a
 * rendering failure so the user is not told to check their masks. */
export class DownloadFailedError extends Error {
  constructor(cause: unknown) {
    super(`The browser could not start the download: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = 'DownloadFailedError';
  }
}
