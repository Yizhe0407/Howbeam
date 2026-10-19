import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Download, Image as ImageIcon, Loader2, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { generateProjectHtml } from '@/lib/export/project-export-html';
import { generateProjectMarkdownArchive } from '@/lib/export/project-export-markdown';
import { generateProjectPdf } from '@/lib/export/project-export-pdf';
import { projectExportFilename, type ProjectExportMetadata } from '@/lib/export/project-export-contract';
import { type StepEntry } from '@/lib/storage/models';
import { downloadBlobViaBrowser } from '@/lib/export/download-utils';
import {
  DownloadFailedError,
  RedactionReviewRequiredError,
  StepImageError,
} from '@/lib/export/export-errors';
import InlineAlert from '@/components/shared/InlineAlert';
import { t } from '@/lib/shared/i18n';
import { isAbortError, throwIfAborted } from '@/lib/shared/abort';

type ProjectEntriesSnapshot = {
  entries: readonly StepEntry[];
  metadata?: ProjectExportMetadata;
};

type ProjectEntriesProvider = (
  signal: AbortSignal,
) =>
  | readonly StepEntry[]
  | ProjectEntriesSnapshot
  | Promise<readonly StepEntry[] | ProjectEntriesSnapshot>;

type PublishProjectDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolves the entries (and optionally fresher metadata) to publish. */
  getProjectEntries: ProjectEntriesProvider;
  metadata?: ProjectExportMetadata;
  /** Resolves `null` when there was nothing to export (so nothing was downloaded). */
  onExportImages?: (signal: AbortSignal) => unknown | Promise<unknown>;
};

type DownloadPublicationAction = Extract<PublicationAction, 'markdown' | 'html' | 'pdf'>;
type PublicationAction = 'markdown' | 'html' | 'pdf' | 'images';

/** Each format's title, label, description and outcome copy, read at render
 * time so it follows the active locale. */
function publicationCopy(action: PublicationAction) {
  return t().editor.publish[action];
}

type PublicationOption = {
  action: PublicationAction;
  title: string;
  ariaLabel: string;
  description: string;
  icon: ReactNode;
  disabled: boolean;
  onSelect: () => void;
};

function MonoGlyph({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`font-mono font-bold leading-none ${className}`}>
      {children}
    </span>
  );
}

function PublicationOptionCard({ option, pending }: { option: PublicationOption; pending: boolean }) {
  return (
    <button
      type="button"
      aria-label={option.ariaLabel}
      disabled={option.disabled}
      onClick={option.onSelect}
      className="group flex items-center justify-between rounded-md border-2 border-border bg-surface-raised p-3.5 text-left outline-none transition-colors focus-ring hover:bg-selected disabled:pointer-events-none disabled:opacity-40"
    >
      <div className="flex min-w-0 items-center gap-4">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-md border-2 border-border bg-card text-foreground">
          {option.icon}
        </div>
        <div className="min-w-0">
          <div className="text-[15px] font-bold text-foreground group-hover:text-on-accent">{option.title}</div>
          <div className="mt-0.5 break-words text-[13px] text-muted-foreground group-hover:text-on-accent">
            {option.description}
          </div>
        </div>
      </div>
      {pending ? (
        <Loader2 className="size-5 shrink-0 animate-spin text-foreground" />
      ) : (
        <Download className="size-5 shrink-0 text-muted-foreground transition-colors group-hover:text-on-accent" />
      )}
    </button>
  );
}

/** Step numbers beyond this many are summarised so the message stays short. */
const MAX_LISTED_STEPS = 6;

/** The message for a failed export: what actually went wrong, not a blanket
 * "check the masks" for failures that have nothing to do with masks. */
function failureMessage(action: PublicationAction, error: unknown): string {
  const copy = t().editor.publish;
  if (error instanceof StepImageError) return copy.stepImageFailed(error.ordinal);
  if (error instanceof RedactionReviewRequiredError && error.ordinals.length > 0) {
    const listed = error.ordinals.slice(0, MAX_LISTED_STEPS).join(', ');
    return copy.reviewRequired(error.ordinals.length > MAX_LISTED_STEPS ? `${listed}…` : listed);
  }
  if (error instanceof DownloadFailedError) return copy.downloadFailed;
  return copy[action].failed;
}

function isProjectEntriesSnapshot(
  value: readonly StepEntry[] | ProjectEntriesSnapshot,
): value is ProjectEntriesSnapshot {
  return !Array.isArray(value);
}

export default function PublishProjectDialog(props: PublishProjectDialogProps) {
  const { open, onOpenChange, metadata = {}, onExportImages } = props;
  const [pendingAction, setPendingAction] = useState<PublicationAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const activeController = useRef<AbortController | null>(null);
  const busy = pendingAction !== null;

  useEffect(() => () => activeController.current?.abort(), []);
  useEffect(() => {
    if (open) {
      setError(null);
      setNotice(null);
    }
  }, [open]);

  function requestOpenChange(nextOpen: boolean) {
    if (!nextOpen) activeController.current?.abort();
    onOpenChange(nextOpen);
  }

  async function resolveProjectEntries(signal: AbortSignal): Promise<ProjectEntriesSnapshot> {
    const result = await props.getProjectEntries(signal);
    throwIfAborted(signal);

    const snapshot = isProjectEntriesSnapshot(result)
      ? { entries: result.entries, metadata: result.metadata ?? metadata }
      : { entries: result, metadata };
    if (snapshot.entries.length === 0) throw new Error('No project entries are available.');
    return snapshot;
  }

  async function runAction(
    action: PublicationAction,
    task: (signal: AbortSignal) => Promise<'nothing' | void>,
  ) {
    if (activeController.current) return;

    const controller = new AbortController();
    activeController.current = controller;
    setPendingAction(action);
    setError(null);
    setNotice(null);

    try {
      const outcome = await task(controller.signal);
      throwIfAborted(controller.signal);
      setNotice(outcome === 'nothing' ? t().editor.publish.nothingExported : publicationCopy(action).started);
    } catch (actionError) {
      if (isAbortError(actionError) || controller.signal.aborted) {
        setNotice(t().editor.publish.cancelled);
      } else {
        console.error(`[howbeam] project export failed: ${action}`, actionError);
        setError(failureMessage(action, actionError));
      }
    } finally {
      if (activeController.current === controller) activeController.current = null;
      setPendingAction(null);
    }
  }

  function downloadProject(action: DownloadPublicationAction) {
    void runAction(
      action,
      async (signal) => {
        const snapshot = await resolveProjectEntries(signal);
        switch (action) {
          // downloadBlobViaBrowser resolves only once the browser has queued the transfer,
          // which survives this page closing, so the success notice below is always accurate.
          case 'markdown': {
            const archive = await generateProjectMarkdownArchive(snapshot.entries, snapshot.metadata, { signal });
            throwIfAborted(signal);
            await downloadBlobViaBrowser(
              archive.blob,
              projectExportFilename(snapshot.metadata, 'markdown-archive'),
              { signal },
            );
            return;
          }

          case 'html': {
            const html = await generateProjectHtml(snapshot.entries, snapshot.metadata, { signal });
            throwIfAborted(signal);
            await downloadBlobViaBrowser(
              html,
              projectExportFilename(snapshot.metadata, 'html'),
              { signal },
            );
            return;
          }

          case 'pdf': {
            const pdf = await generateProjectPdf(snapshot.entries, snapshot.metadata, { signal });
            throwIfAborted(signal);
            await downloadBlobViaBrowser(pdf, projectExportFilename(snapshot.metadata, 'pdf'), { signal });
            return;
          }
        }
      },
    );
  }

  function exportImages() {
    if (!onExportImages) return;
    void runAction(
      'images',
      async (signal) => {
        // exportImagesAsZip resolves null when no image could be exported.
        return (await onExportImages(signal)) === null ? 'nothing' : undefined;
      },
    );
  }

  const titleText = metadata.title?.trim() || t().common.untitledProject;
  const publicationOptions: readonly PublicationOption[] = [
    {
      action: 'markdown',
      title: publicationCopy('markdown').title,
      ariaLabel: publicationCopy('markdown').label,
      description: publicationCopy('markdown').description,
      icon: <MonoGlyph className="text-sm">M↓</MonoGlyph>,
      disabled: busy,
      onSelect: () => downloadProject('markdown'),
    },
    {
      action: 'pdf',
      title: publicationCopy('pdf').title,
      ariaLabel: publicationCopy('pdf').label,
      description: publicationCopy('pdf').description,
      icon: <MonoGlyph className="text-sm">PDF</MonoGlyph>,
      disabled: busy,
      onSelect: () => downloadProject('pdf'),
    },
    {
      action: 'images',
      title: publicationCopy('images').title,
      ariaLabel: publicationCopy('images').label,
      description: publicationCopy('images').description,
      icon: <ImageIcon className="size-5 text-foreground" />,
      disabled: busy || !onExportImages,
      onSelect: exportImages,
    },
    {
      action: 'html',
      title: publicationCopy('html').title,
      ariaLabel: publicationCopy('html').label,
      description: publicationCopy('html').description,
      icon: <MonoGlyph className="text-sm">&lt;/&gt;</MonoGlyph>,
      disabled: busy,
      onSelect: () => downloadProject('html'),
    },
  ];

  return (
    <Dialog open={open} onOpenChange={requestOpenChange}>
      <DialogContent
        showClose={false}
        className="app-scrollbar max-h-[calc(100vh-32px)] w-[92vw] max-w-[480px] overflow-y-auto p-6"
      >
        <div className="flex items-start gap-3 pb-2">
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-xl font-bold text-foreground">{t().editor.publish.title}</DialogTitle>
            <DialogDescription className="mt-1 break-words">
              {t().common.quoted(titleText)}
            </DialogDescription>
          </div>
          <button
            type="button"
            onClick={() => requestOpenChange(false)}
            aria-label={t().common.close}
            className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors focus-ring hover:bg-secondary hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="mt-4 flex flex-col gap-3">
          {publicationOptions.map((option) => (
            <PublicationOptionCard
              key={option.action}
              option={option}
              pending={pendingAction === option.action}
            />
          ))}
        </div>

        <div aria-live="polite" aria-atomic="true" className="mt-3 empty:mt-0">
          {error && <InlineAlert>{error}</InlineAlert>}
          {!error && notice && (
            <p role="status" className="rounded-md border-2 border-border bg-brand-bg-soft px-3.5 py-2.5 text-xs font-bold text-foreground">
              {notice}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
