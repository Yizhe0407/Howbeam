import type { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { navigateInPlace } from '@/lib/runtime/page-navigation';
import { t } from '@/lib/shared/i18n';
import { cn } from '@/lib/shared/utils';

interface Props {
  title: ReactNode;
  /** The page one level up, offered as a way back above the title. */
  parent?: 'library';
  /** Goes back without leaving this page, for a view inside it (a Series in the Library). */
  onParent?: () => void;
  /** Art shown beside the title, such as the welcome page's mascot. */
  leading?: ReactNode;
  description?: ReactNode;
  className?: string;
}

/**
 * The title every content page opens its body with, so "where am I" always
 * reads in the same place. The editor is the exception: it titles itself in
 * the shared header (see AppHeader).
 */
export default function PageHeading({ title, parent, onParent, leading, description, className }: Props) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {parent && (
        <button
          type="button"
          aria-label={t().common.backToLibrary}
          onClick={() => (onParent ? onParent() : navigateInPlace(parent))}
          className="-ml-1 flex w-fit items-center gap-0.5 rounded-sm px-1 py-0.5 text-sm font-bold text-muted-foreground outline-none transition-colors focus-ring hover:text-foreground"
        >
          <ChevronLeft className="size-4 shrink-0" aria-hidden="true" />
          {t().common.library}
        </button>
      )}
      <div className="flex items-center gap-4">
        {leading}
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="text-2xl leading-tight font-bold text-foreground">{title}</h1>
          {description && <p className="text-sm leading-relaxed text-muted-foreground sm:text-base">{description}</p>}
        </div>
      </div>
    </div>
  );
}
