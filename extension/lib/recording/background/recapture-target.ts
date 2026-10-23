import { browser } from 'wxt/browser';
import { getEffectiveBounds, stepRole } from '../../storage/models';
import { getStep, getSteps, type StepRecaptureError, type StepRecaptureTarget } from '../../storage/step-repository';
import type {
  PreflightStepRecaptureSourcePermissionErrorCode,
  StartStepRecaptureMessage,
} from '../../runtime/messages';
import type { RecordingState } from '../../storage/recording-state';
import { t } from '@/lib/shared/i18n';

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
    message: string,
  ) {
    super(message);
    this.name = 'StepRecaptureStartError';
  }
}

/** Localized copy for a replacement the repository refused; its own messages
 * are English diagnostics for the console. */
export function recaptureTargetErrorMessage(
  code: StepRecaptureError['code'],
  kind: StepRecaptureTarget['kind'],
): string {
  const single = kind === 'single';
  if (code === 'TARGET_NOT_FOUND') return single ? t().recaptureFlow.stepNotFound : t().recaptureFlow.snapshotNotFound;
  if (code === 'TARGET_CHANGED') return single ? t().recaptureFlow.stepChanged : t().recaptureFlow.snapshotChanged;
  return t().recaptureFlow.multiAnnotation;
}

/** A single step with its own image, or a snapshot with exactly one annotation. */
export async function validateRecaptureTarget(
  sessionId: string,
  target: StartStepRecaptureMessage['target'],
): Promise<ValidatedRecaptureTarget> {
  if (target.kind === 'single') {
    const step = await getStep(target.stepId);
    if (!step || step.sessionId !== sessionId) {
      throw new StepRecaptureStartError('TARGET_NOT_FOUND', t().recaptureFlow.stepNotFound);
    }
    if (step.groupId || !step.screenshotBlob || !getEffectiveBounds(step)) {
      throw new StepRecaptureStartError('TARGET_CHANGED', t().recaptureFlow.stepChanged);
    }
    return { target, entryId: step.id, sourceUrl: step.url };
  }

  const [anchor, annotation, steps] = await Promise.all([
    getStep(target.anchorId),
    getStep(target.annotationId),
    getSteps(sessionId),
  ]);
  if (!anchor || !annotation || anchor.sessionId !== sessionId || annotation.sessionId !== sessionId) {
    throw new StepRecaptureStartError('TARGET_NOT_FOUND', t().recaptureFlow.snapshotNotFound);
  }
  if (
    stepRole(anchor) !== 'anchor' ||
    annotation.groupId !== anchor.id ||
    stepRole(annotation) !== 'annotation' ||
    !anchor.screenshotBlob ||
    !getEffectiveBounds(annotation)
  ) {
    throw new StepRecaptureStartError('TARGET_CHANGED', t().recaptureFlow.snapshotChanged);
  }
  const annotations = steps.filter(
    (step) => step.groupId === anchor.id && stepRole(step) === 'annotation' && getEffectiveBounds(step),
  );
  const [only, ...others] = annotations;
  if (!only || others.length > 0 || only.id !== annotation.id) {
    throw new StepRecaptureStartError(
      'UNSUPPORTED_SNAPSHOT_GROUP',
      t().recaptureFlow.multiAnnotation,
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
