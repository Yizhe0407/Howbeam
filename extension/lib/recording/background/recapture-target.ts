import { browser } from 'wxt/browser';
import { getEffectiveBounds, stepRole } from '../../storage/models';
import { getStep, getStepOutlines, type StepRecaptureError, type StepRecaptureTarget } from '../../storage/step-repository';
import type {
  PreflightStepRecaptureSourcePermissionErrorCode,
  StartStepRecaptureMessage,
} from '../../runtime/messages';
import type { RecordingState } from '../../storage/recording-state';
import type { CopyKey } from '../../shared/i18n/copy';

/** What a recapture may replace, read back from storage: the step (or the
 * snapshot anchor) it reopens in the editor and the page it was taken on. */
export type ValidatedRecaptureTarget = {
  target: StepRecaptureTarget;
  entryId: string;
  sourceUrl: string;
};

type StepRecaptureValidationErrorCode = Exclude<
  PreflightStepRecaptureSourcePermissionErrorCode,
  'INVALID_EDITOR' | 'RESTRICTED_SOURCE'
>;

export class StepRecaptureStartError extends Error {
  constructor(
    readonly code: StepRecaptureValidationErrorCode,
    readonly copy: CopyKey,
  ) {
    super(copy);
    this.name = 'StepRecaptureStartError';
  }
}

/** The copy for a replacement the repository refused; its own messages
 * are English diagnostics for the console. */
export function recaptureTargetErrorCopy(
  code: StepRecaptureError['code'],
  kind: StepRecaptureTarget['kind'],
): CopyKey {
  const single = kind === 'single';
  if (code === 'TARGET_NOT_FOUND') return single ? 'recaptureFlow.stepNotFound' : 'recaptureFlow.snapshotNotFound';
  if (code === 'TARGET_CHANGED') return single ? 'recaptureFlow.stepChanged' : 'recaptureFlow.snapshotChanged';
  return 'recaptureFlow.multiAnnotation';
}

/** A single step with its own image, or a snapshot with exactly one annotation. */
export async function validateRecaptureTarget(
  sessionId: string,
  target: StartStepRecaptureMessage['target'],
): Promise<ValidatedRecaptureTarget> {
  if (target.kind === 'single') {
    const step = await getStep(target.stepId);
    if (!step || step.sessionId !== sessionId) {
      throw new StepRecaptureStartError('TARGET_NOT_FOUND', 'recaptureFlow.stepNotFound');
    }
    if (step.groupId || !step.screenshotBlob) {
      throw new StepRecaptureStartError('TARGET_CHANGED', 'recaptureFlow.stepChanged');
    }
    return { target, entryId: step.id, sourceUrl: step.url };
  }

  const [anchor, annotation, steps] = await Promise.all([
    getStep(target.anchorId),
    getStep(target.annotationId),
    getStepOutlines(sessionId),
  ]);
  if (!anchor || !annotation || anchor.sessionId !== sessionId || annotation.sessionId !== sessionId) {
    throw new StepRecaptureStartError('TARGET_NOT_FOUND', 'recaptureFlow.snapshotNotFound');
  }
  if (
    stepRole(anchor) !== 'anchor' ||
    annotation.groupId !== anchor.id ||
    stepRole(annotation) !== 'annotation' ||
    !anchor.screenshotBlob ||
    !getEffectiveBounds(annotation)
  ) {
    throw new StepRecaptureStartError('TARGET_CHANGED', 'recaptureFlow.snapshotChanged');
  }
  const annotations = steps.filter(
    (step) => step.groupId === anchor.id && stepRole(step) === 'annotation' && getEffectiveBounds(step),
  );
  const [only, ...others] = annotations;
  if (!only || others.length > 0 || only.id !== annotation.id) {
    throw new StepRecaptureStartError(
      'UNSUPPORTED_SNAPSHOT_GROUP',
      'recaptureFlow.multiAnnotation',
    );
  }
  return { target, entryId: anchor.id, sourceUrl: anchor.url };
}

/** The replacement reached storage: the target carries this run's capture marker. */
export async function wasRecaptureCommitted(context: NonNullable<RecordingState['recapture']>): Promise<boolean> {
  const ownerId = context.target.kind === 'single' ? context.target.stepId : context.target.anchorId;
  const owner = await getStep(ownerId);
  return owner?.sessionId === context.sessionId && owner.lastCaptureRunId === context.runId;
}

export async function isRecaptureSourceTabIntact(
  context: NonNullable<RecordingState['recapture']>,
): Promise<boolean> {
  try {
    const tab = await browser.tabs.get(context.sourceTabId);
    // Recapture required a host permission grant for the source origin, so the
    // URL is readable whenever the tab still shows the page selection armed on.
    return tab.url === context.sourceUrl;
  } catch {
    return false;
  }
}
