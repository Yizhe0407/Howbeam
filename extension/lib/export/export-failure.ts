import { EditingBlockedError } from '../editor/editor-app-model';
import { t } from '../shared/i18n';
import {
  DownloadFailedError,
  RedactionReviewRequiredError,
  SeriesProjectExportError,
  StepImageError,
} from './export-errors';

export type PublicationAction = 'pdf' | 'html' | 'markdown' | 'images';

/** Step numbers beyond this many are summarised so the message stays short. */
const MAX_LISTED_STEPS = 6;

/** The message for a failed export: what actually went wrong, not a blanket
 * "check the masks" for failures that have nothing to do with masks. */
export function exportFailureMessage(action: PublicationAction, error: unknown): string {
  const copy = t().editor.publish;
  if (error instanceof SeriesProjectExportError) {
    return t().library.series.exportProjectFailed(error.projectTitle, exportFailureMessage(action, error.cause));
  }
  if (error instanceof StepImageError) return copy.stepImageFailed(error.ordinal);
  if (error instanceof RedactionReviewRequiredError && error.ordinals.length > 0) {
    const listed = error.ordinals.slice(0, MAX_LISTED_STEPS).join(', ');
    return copy.reviewRequired(error.ordinals.length > MAX_LISTED_STEPS ? `${listed}…` : listed);
  }
  if (error instanceof DownloadFailedError) return copy.downloadFailed;
  if (error instanceof EditingBlockedError) return t().editor.publishBusy;
  return copy[action].failed;
}
