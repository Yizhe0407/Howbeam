import { Download } from 'lucide-react';
import AppHeader from '../shared/AppHeader';
import type { ActiveOperation } from '@/lib/storage/recording-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import ExportPopover, { type ExportPopoverProps } from './ExportPopover';
import { t } from '@/lib/shared/i18n';
import { projectDisplayTitle } from '@/lib/storage/models';

interface Props {
  operationActive: boolean;
  editingDisabled?: boolean;
  operation?: ActiveOperation;
  /** Whether the Project has anything to export. */
  hasSteps: boolean;
  /** The open project's title, shown as the current crumb; null before it loads. */
  projectTitle?: string | null;
  /** False when there is no project to act on (a missing project): only the way
   * back to the library stays, instead of a row of permanently disabled buttons. */
  projectActionsAvailable?: boolean;
  /** What the export panel needs; without it the Export button stays disabled. */
  publish?: Omit<ExportPopoverProps, 'trigger'>;
  /** Saves pending descriptions before the tab leaves; false keeps the editor. */
  beforeNavigate?: () => Promise<boolean>;
}

export default function EditorHeader({
  operationActive,
  editingDisabled = false,
  operation,
  hasSteps,
  projectTitle = null,
  projectActionsAvailable = true,
  publish,
  beforeNavigate,
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

  return (
    <AppHeader
      current={projectTitle == null ? t().common.editor : projectDisplayTitle(projectTitle)}
      currentHeading={{ id: 'howbeam-editor-title' }}
      beforeNavigate={beforeNavigate}
      status={operationActive && (
        <Badge variant="status" className="min-w-0">
          <span className="size-1.5 rounded-full bg-recording animate-pulse" />
          <span className="truncate">{operation === 'recapture' ? t().common.recapturing : t().common.recording}</span>
        </Badge>
      )}
      actions={projectActionsAvailable && (
        <>
          {publish ? <ExportPopover {...publish} trigger={exportButton} /> : exportButton}
        </>
      )}
    />
  );
}
