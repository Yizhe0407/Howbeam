import { Loader2, PencilLine } from 'lucide-react';
import { t } from '@/lib/shared/i18n';
import { useDeferredBusy } from '@/lib/shared/use-deferred-busy';

interface Props {
  /** Copy while idle. The pending copy is owned here because it is identical on
   * every surface. */
  label: string;
  pending: boolean;
  onOpen?: () => void | Promise<void>;
  /** The three call sites carry deliberately different visual weight (primary
   * in editor recovery, outlined full-width in the idle nav, ghost as the
   * live-run secondary exit), so each passes its own `buttonVariants` classes. */
  className?: string;
}

/**
 * The popup's 「開啟編輯器」 button. It exists once so the pending label, the
 * spinner-or-icon swap and the disabled-while-pending rule cannot drift apart
 * between the idle nav, the editor-recovery branch and the live-run exit.
 */
export default function OpenEditorButton({ label, pending, onOpen, className }: Props) {
  const pendingShown = useDeferredBusy(pending);
  return (
    <button
      type="button"
      onClick={() => !pending && void onOpen?.()}
      disabled={pendingShown || !onOpen}
      className={className}
    >
      {pendingShown
        ? <Loader2 className="animate-spin" />
        : <PencilLine />}
      {pendingShown ? t().common.openingEditor : label}
    </button>
  );
}
