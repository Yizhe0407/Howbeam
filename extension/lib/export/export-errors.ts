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
    super(`The browser could not start the download: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'DownloadFailedError';
  }
}

/** One Project of a Series failed to export; `cause` is that Project's own failure. */
export class SeriesProjectExportError extends Error {
  readonly projectTitle: string;

  constructor(projectTitle: string, cause: unknown) {
    super(`Project "${projectTitle}" could not be exported.`, { cause });
    this.name = 'SeriesProjectExportError';
    this.projectTitle = projectTitle;
  }
}

/** A Series too large to merge into one document; each Project still exports on its own. */
export class SeriesTooLargeError extends Error {
  constructor() {
    super('The series is too large to merge into one document.');
    this.name = 'SeriesTooLargeError';
  }
}
