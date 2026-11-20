import { Download } from 'lucide-react';
import AppHeader from '../shared/AppHeader';
import type { ActiveOperation } from '@/lib/storage/recording-state';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import ExportPopover, { type ExportPopoverProps } from './ExportPopover';
import { t } from '@/lib/shared/i18n';
import { projectDisplayTitle } from '@/lib/storage/models';
import { PERSISTED_PROJECT_LIMITS } from '@/lib/storage/persistence-limits';
import EditableTitle from '../shared/EditableTitle';
import OverflowTooltip from '../shared/OverflowTooltip';

interface Props {
  operationActive: boolean;
  editingDisabled?: boolean;
  operation?: ActiveOperation;
  /** Whether the Project has anything to export. */
  hasSteps: boolean;
  /** The open project's title, shown as the page title in the header; null before it loads. */
  projectTitle?: string | null;
  /** Renames the project from its title; a rejection reverts the title and goes to `onTitleError`. */
  onTitleChange?: (title: string) => Promise<void>;
  onTitleError?: (error: unknown) => void;
  /** False when there is no project to act on (a missing project): only the way
   * back to the library stays, instead of a row of permanently disabled buttons. */
  projectActionsAvailable?: boolean;
  /** What the export panel needs; without it the Export button stays disabled. */
  publish?: Omit<ExportPopoverProps, 'trigger'>;
  /** Saves pending step text before the tab leaves; false keeps the editor. */
  beforeNavigate?: () => Promise<boolean>;
  /** Brings the recorded tab forward; the editor is locked while a run is live, so the badge is the way back. */
  onShowRecording?: () => void;
}

export default function EditorHeader({
  operationActive,
  editingDisabled = false,
  operation,
  hasSteps,
  projectTitle = null,
  onTitleChange,
  onTitleError,
  projectActionsAvailable = true,
  publish,
  beforeNavigate,
  onShowRecording,
}: Props) {
  const unavailable = operationActive || editingDisabled;
  const exportButton = (
    // Icon always shows; label appears from `sm` up. `aria-label` keeps the icon-only state accessible.
    <Button
      variant="default"
      aria-label={t().common.export}
      className="px-2.5 sm:px-4"
      disabled={unavailable || !hasSteps || !publish}
    >
      <Download /><span className="hidden sm:inline">{t().common.export}</span>
    </Button>
  );

  const location = projectTitle == null ? t().common.editor : projectDisplayTitle(projectTitle);
  const title = (
    // Named by the location alone, not by the rename control's own label inside it.
    <h1 id="howbeam-editor-title" tabIndex={-1} aria-label={location} className="flex min-w-0 text-base font-bold text-foreground outline-none">
      {projectTitle != null && onTitleChange ? (
        <EditableTitle
          value={projectTitle}
          maxLength={PERSISTED_PROJECT_LIMITS.maxTitleLength}
          fallback={t().common.untitledProject}
          label={t().editor.projectTitle.label}
          disabled={editingDisabled || operationActive}
          onCommit={onTitleChange}
          onCommitError={onTitleError}
          className="block min-w-0 max-w-full truncate rounded-sm border-2 border-transparent px-1.5 py-0.5 text-base font-bold text-foreground outline-none transition-colors focus-ring hover:border-border-soft focus:border-border focus:bg-background [field-sizing:content]"
        />
      ) : (
        // Truncates on narrow windows; the tooltip keeps the full name reachable.
        <OverflowTooltip content={location}>
          <span className="block min-w-0 truncate px-1.5 py-1">{location}</span>
        </OverflowTooltip>
      )}
    </h1>
  );

  return (
    <AppHeader
      page="editor"
      title={title}
      beforeNavigate={beforeNavigate}
      status={operationActive && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="status" className="min-w-0 hover:bg-danger-soft/70 disabled:pointer-events-none" asChild>
              <button type="button" onClick={onShowRecording} disabled={!onShowRecording}>
                <span className="size-1.5 rounded-full bg-recording animate-pulse" />
                <span className="truncate">{operation === 'recapture' ? t().common.recapturing : t().common.recording}</span>
              </button>
            </Badge>
          </TooltipTrigger>
          {onShowRecording && <TooltipContent>{t().popup.returnToRecordingTab}</TooltipContent>}
        </Tooltip>
      )}
      actions={projectActionsAvailable && (
        <>
          {publish ? <ExportPopover {...publish} trigger={exportButton} /> : exportButton}
        </>
      )}
    />
  );
}
