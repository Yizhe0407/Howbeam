import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/shared/i18n';

interface Props {
  children: ReactNode;
  /** Surface name shown in the fallback copy, e.g. 「編輯器」. */
  label?: string;
  /** Called when the user retries; the boundary clears its own error first. */
  onReset?: () => void;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time throws so a single broken subtree cannot white-screen a
 * whole extension surface. Error boundaries must be class components: React has
 * no hook equivalent for `getDerivedStateFromError`.
 */
export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(
      `[howbeam] unexpected render error in ${this.props.label ?? 'a surface'}`,
      error,
      errorInfo.componentStack,
    );
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { label, onReset } = this.props;

    return (
      <div
        role="alert"
        className="flex w-full flex-1 flex-col items-center justify-center gap-4 bg-background px-5 py-8 text-center"
      >
        <span className="flex size-11 items-center justify-center rounded-full border-2 border-border bg-danger-soft">
          <TriangleAlert className="size-5 text-danger" />
        </span>
        <div className="flex w-full max-w-[280px] flex-col items-center gap-2">
          <h2 className="text-base font-bold text-foreground">
            {t().errorBoundary.title(label)}
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t().errorBoundary.body}
          </p>
          <p className="w-full truncate rounded-md border-2 border-border-soft bg-secondary px-2.5 py-1 font-mono text-xs text-muted-foreground">
            {error.message || t().errorBoundary.unknownError}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button size="sm" onClick={() => window.location.reload()}>
            <RotateCcw />
            {t().common.reload}
          </Button>
          {onReset && (
            <Button size="sm" variant="outline" onClick={this.handleRetry}>
              {t().common.retry}
            </Button>
          )}
        </div>
      </div>
    );
  }
}
