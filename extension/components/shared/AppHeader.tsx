import type { ReactNode } from 'react';
import { ChevronRight, Settings } from 'lucide-react';
import BrandMark from './BrandMark';
import Mascot from './Mascot';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { navigateInPlace, type InPlacePage } from '@/lib/runtime/page-navigation';
import { t } from '@/lib/shared/i18n';
import { cn } from '@/lib/shared/utils';

interface CommonProps {
  /** The page's own actions; the settings button always comes last. */
  actions?: ReactNode;
  /**
   * Asked before the tab leaves this page; resolving false keeps the page
   * (the editor uses it to save step text, and shows why it stayed).
   */
  beforeNavigate?: () => Promise<boolean>;
}

/**
 * Content pages keep the bar identical everywhere and title themselves in the
 * body (see PageHeading). The editor is a workspace: its document's title sits
 * in the bar, so the canvas keeps the vertical room.
 */
type Props = CommonProps & (
  | { page: InPlacePage }
  | {
      page: 'editor';
      /** The page's <h1>, shown after the home crumb. */
      title: ReactNode;
      /** Live status shown right after the title (e.g. a recording badge). */
      status?: ReactNode;
    }
);

const brandClass = 'flex shrink-0 items-center rounded-sm px-1.5 py-1';

/**
 * The one bar every full-page surface shares: the brand leads home, settings
 * keeps the same corner, and both navigate within the same tab.
 */
export default function AppHeader(props: Props) {
  const { page, actions, beforeNavigate } = props;

  async function navigate(target: InPlacePage): Promise<void> {
    if (beforeNavigate && !(await beforeNavigate())) return;
    navigateInPlace(target);
  }

  const brandMark = page === 'editor' ? <Mascot /> : <BrandMark />;
  const homeButton = (
    <button
      type="button"
      aria-label={t().nav.homeLabel}
      onClick={() => void navigate('library')}
      className={cn(brandClass, 'outline-none transition-colors focus-ring hover:bg-secondary')}
    >
      {brandMark}
    </button>
  );
  // Pulled left by its own hover padding, so the mascot sits exactly on the
  // page gutter that the content below aligns to.
  const brand = (
    <div className="-ml-1.5 flex shrink-0 items-center">
      {page === 'library' ? (
        <span className={brandClass}>{brandMark}</span>
      ) : page === 'editor' ? (
        <Tooltip>
          <TooltipTrigger asChild>{homeButton}</TooltipTrigger>
          <TooltipContent>{t().nav.homeLabel}</TooltipContent>
        </Tooltip>
      ) : (
        homeButton
      )}
    </div>
  );

  return (
    <header className="flex h-16 min-h-16 shrink-0 items-center gap-2 border-b-2 border-border bg-card px-4 sm:gap-3 sm:px-8">
      {props.page === 'editor' ? (
        <nav aria-label={t().nav.breadcrumb} className="min-w-0 flex-1">
          <ol className="flex min-w-0 items-center gap-1">
            <li className="flex shrink-0 items-center">{brand}</li>
            <li aria-current="page" className="flex min-w-0 items-center gap-1">
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              {props.title}
            </li>
            {props.status && <li className="ml-1 flex min-w-0 items-center">{props.status}</li>}
          </ol>
        </nav>
      ) : (
        <div className="flex min-w-0 flex-1 items-center">{brand}</div>
      )}
      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
        {actions && (
          <>
            {actions}
            <span className="hidden h-6 w-0.5 rounded-full bg-border-soft sm:block" aria-hidden="true" />
          </>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t().settings.open}
              aria-current={page === 'options' ? 'page' : undefined}
              onClick={page === 'options' ? undefined : () => void navigate('options')}
              className={cn(page === 'options' && 'border-border bg-selected text-on-accent hover:bg-selected hover:text-on-accent')}
            >
              <Settings />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t().settings.open}</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
